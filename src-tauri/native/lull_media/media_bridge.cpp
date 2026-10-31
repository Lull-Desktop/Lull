// WebView2 TextureStream adapter for Lull.
//
// This file deliberately owns no decoder and no frame lifetime: media-pp hands a
// decoded ID3D11Texture2D to D3d11FrameRenderer, which calls submit_nv12 here;
// the copy finishes before that call returns. WebView2 owns the target texture
// pool through GetAvailableTexture/PresentTexture.

#include "media_bridge.h"
#include "webview2_texture_stream.h"

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <atomic>
#include <cstdio>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr uint32_t kAbiVersion = 1;
constexpr int kStateCreated = 0;
constexpr int kStateStarted = 1;
constexpr int kStateStopped = 2;
constexpr int kStateError = 3;
constexpr int kStateAdapterLost = 4;

void EnsureComInitialized() {
	thread_local const bool initialized = []() {
		CoInitializeEx(nullptr, COINIT_MULTITHREADED);
		return true;
	}();
	(void)initialized;
}

uint64_t AdapterLuidOf(ID3D11Device *device) {
	ComPtr<IDXGIDevice> dxgi;
	if (FAILED(device->QueryInterface(IID_PPV_ARGS(&dxgi)))) {
		return 0;
	}
	ComPtr<IDXGIAdapter> adapter;
	if (FAILED(dxgi->GetAdapter(&adapter))) {
		return 0;
	}
	DXGI_ADAPTER_DESC desc{};
	if (FAILED(adapter->GetDesc(&desc))) {
		return 0;
	}
	return (static_cast<uint64_t>(static_cast<uint32_t>(desc.AdapterLuid.HighPart)) << 32) |
			static_cast<uint64_t>(desc.AdapterLuid.LowPart);
}

class StreamState;

constexpr UINT kDispatchSubmit = WM_APP + 0x51;
constexpr UINT kDispatchShutdown = WM_APP + 0x52;
constexpr wchar_t kDispatchClass[] = L"LullMediaTextureDispatch";

LRESULT CALLBACK DispatchWndProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);

class StartHandler final
		: public Microsoft::WRL::RuntimeClass<
					Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
					ICoreWebView2ExperimentalTextureStreamStartRequestedEventHandler> {
public:
	explicit StartHandler(std::weak_ptr<StreamState> state) : state_(std::move(state)) {}
	HRESULT STDMETHODCALLTYPE Invoke(
			ICoreWebView2ExperimentalTextureStream *,
			IUnknown *) override;

private:
	std::weak_ptr<StreamState> state_;
};

class StopHandler final
		: public Microsoft::WRL::RuntimeClass<
					Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
					ICoreWebView2ExperimentalTextureStreamStoppedEventHandler> {
public:
	explicit StopHandler(std::weak_ptr<StreamState> state) : state_(std::move(state)) {}
	HRESULT STDMETHODCALLTYPE Invoke(
			ICoreWebView2ExperimentalTextureStream *,
			IUnknown *) override;

private:
	std::weak_ptr<StreamState> state_;
};

class ErrorHandler final
		: public Microsoft::WRL::RuntimeClass<
					Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
					ICoreWebView2ExperimentalTextureStreamErrorReceivedEventHandler> {
public:
	explicit ErrorHandler(std::weak_ptr<StreamState> state) : state_(std::move(state)) {}
	HRESULT STDMETHODCALLTYPE Invoke(
			ICoreWebView2ExperimentalTextureStream *,
			ICoreWebView2ExperimentalTextureStreamErrorReceivedEventArgs *) override;

private:
	std::weak_ptr<StreamState> state_;
};

class StreamState final : public std::enable_shared_from_this<StreamState> {
public:
	// SubmitNV12 由 media-pp 解码线程调用，但 TextureStream 是 WebView2 的 STA
	// 对象，只能在创建它的 UI 线程使用；通过 hidden window 把复制/呈现 marshal
	// 回 UI 线程，解码线程等待完成后再归还源纹理。
	struct SubmitRequest {
		std::shared_ptr<StreamState> state;
		ID3D11Texture2D *source = nullptr;
		uint32_t array_index = 0;
		uint32_t width = 0;
		uint32_t height = 0;
		uint64_t timestamp_us = 0;
		HANDLE done = nullptr;
		int result = E_FAIL;
	};

	HRESULT Initialize(
			void *environment,
			void *d3d_device,
			const wchar_t *stream_id,
			const wchar_t *origin) {
		if (environment == nullptr || d3d_device == nullptr || stream_id == nullptr ||
				origin == nullptr) {
			return E_POINTER;
		}
		ComPtr<IUnknown> env_unknown(static_cast<IUnknown *>(environment));
		ComPtr<ICoreWebView2ExperimentalEnvironment12> env12;
		HRESULT hr = env_unknown.As(&env12);
		if (FAILED(hr)) {
			return hr;
		}
		ComPtr<ID3D11Device> device(static_cast<ID3D11Device *>(d3d_device));
		UINT64 render_luid = 0;
		hr = env12->get_RenderAdapterLUID(&render_luid);
		if (FAILED(hr)) {
			return hr;
		}
		const uint64_t device_luid = AdapterLuidOf(device.Get());
		if (device_luid == 0) {
			fprintf(stderr, "lull_media: device adapter LUID unavailable\n");
			return E_FAIL;
		}
		if (device_luid != render_luid) {
			fprintf(stderr,
					"lull_media: adapter mismatch render=0x%016llx device=0x%016llx\n",
					static_cast<unsigned long long>(render_luid),
					static_cast<unsigned long long>(device_luid));
			return E_INVALIDARG;
		}
		hr = env12->CreateTextureStream(stream_id, device.Get(), &stream_);
		if (FAILED(hr)) {
			fprintf(stderr,
					"lull_media: CreateTextureStream hr=0x%08lx luid=0x%016llx\n",
					static_cast<unsigned long>(hr),
					static_cast<unsigned long long>(render_luid));
			return hr;
		}
		hr = stream_->AddAllowedOrigin(origin, TRUE);
		if (FAILED(hr)) {
			return hr;
		}
		device_ = device;
		device_->GetImmediateContext(&context_);
		if (!context_) {
			return E_FAIL;
		}

		start_handler_ = Microsoft::WRL::Make<StartHandler>(weak_from_this());
		stop_handler_ = Microsoft::WRL::Make<StopHandler>(weak_from_this());
		error_handler_ = Microsoft::WRL::Make<ErrorHandler>(weak_from_this());
		hr = stream_->add_StartRequested(start_handler_.Get(), &start_token_);
		if (FAILED(hr)) {
			return hr;
		}
		hr = stream_->add_Stopped(stop_handler_.Get(), &stop_token_);
		if (FAILED(hr)) {
			return hr;
		}
		hr = stream_->add_ErrorReceived(error_handler_.Get(), &error_token_);
		if (FAILED(hr)) {
			return hr;
		}
		state_.store(kStateCreated, std::memory_order_release);
		CreateDispatchWindow();
		return S_OK;
	}

	void OnStarted() {
		fprintf(stderr, "lull_media: StartRequested\n");
		state_.store(kStateStarted, std::memory_order_release);
	}

	void OnStopped() {
		fprintf(stderr, "lull_media: Stopped\n");
		state_.store(kStateStopped, std::memory_order_release);
	}

	void OnError(HRESULT hr) {
		fprintf(stderr, "lull_media: stream error hr=0x%08lx\n",
				static_cast<unsigned long>(hr));
		last_error_.store(hr, std::memory_order_release);
		state_.store(kStateError, std::memory_order_release);
	}

	void OnAdapterLost() {
		state_.store(kStateAdapterLost, std::memory_order_release);
	}

	int State() const {
		return state_.load(std::memory_order_acquire);
	}

	HRESULT LastError() const {
		return static_cast<HRESULT>(last_error_.load(std::memory_order_acquire));
	}

	void Stop() {
		std::lock_guard<std::mutex> lock(mutex_);
		if (stream_ && state_.load(std::memory_order_acquire) == kStateStarted) {
			stream_->Stop();
		}
		state_.store(kStateStopped, std::memory_order_release);
	}

	void CreateDispatchWindow() {
		WNDCLASSEXW wc{};
		wc.cbSize = sizeof(wc);
		wc.lpfnWndProc = DispatchWndProc;
		wc.hInstance = GetModuleHandleW(nullptr);
		wc.lpszClassName = kDispatchClass;
		RegisterClassExW(&wc);
		dispatch_hwnd_ = CreateWindowExW(
				0,
				kDispatchClass,
				L"",
				0,
				0,
				0,
				0,
				0,
				HWND_MESSAGE,
				nullptr,
				wc.hInstance,
				this);
		if (!dispatch_hwnd_) {
			fprintf(stderr, "lull_media: CreateWindowEx(message) failed err=%lu\n",
					static_cast<unsigned long>(GetLastError()));
			return;
		}
		SetWindowLongPtrW(
				dispatch_hwnd_, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
		dispatch_thread_id_ = GetCurrentThreadId();
	}

	/** 必须在 WebView2 UI 线程调用。 */
	int SubmitNV12OnUi(
			ID3D11Texture2D *source,
			uint32_t array_index,
			uint32_t width,
			uint32_t height,
			uint64_t timestamp_us) {

	// Returns 0 for presented-or-intentionally-dropped, negative HRESULT on a
	// real failure. The source texture is borrowed for this call only.
		if (source == nullptr || width == 0 || height == 0) {
			return E_INVALIDARG;
		}
		std::lock_guard<std::mutex> lock(mutex_);
		if (!stream_ || !context_) {
			return E_HANDLE;
		}
		if (state_.load(std::memory_order_acquire) != kStateStarted) {
			if (!not_started_logged_) {
				not_started_logged_ = true;
				fprintf(stderr, "lull_media: frame before StartRequested (dropped)\n");
			}
			return 1; // JS has not requested the stream yet; drop this frame.
		}
		const bool first_frame = !started_logged_;
		if (first_frame) {
			started_logged_ = true;
			fprintf(stderr, "lull_media: first frame after StartRequested %ux%u\n", width, height);
		}
		if (width_ != width || height_ != height) {
			CloseTexturesLocked();
			width_ = width;
			height_ = height;
		}

		ComPtr<ICoreWebView2ExperimentalTexture> target;
		HRESULT hr = stream_->GetAvailableTexture(&target);
		if (SUCCEEDED(hr) && !TextureMatches(target.Get(), width, height)) {
			stream_->CloseTexture(target.Get());
			target.Reset();
			hr = E_FAIL;
		}
		if (FAILED(hr)) {
			hr = stream_->CreateTexture(width, height, &target);
			if (FAILED(hr)) {
				OnError(hr);
				return hr;
			}
			textures_.push_back(target);
			if (!TextureMatches(target.Get(), width, height)) {
				OnError(E_FAIL);
				return E_FAIL;
			}
		}

		ComPtr<IUnknown> resource;
		hr = target->get_Resource(&resource);
		if (FAILED(hr)) {
			OnError(hr);
			return hr;
		}
		ComPtr<ID3D11Texture2D> destination;
		hr = resource.As(&destination);
		if (FAILED(hr)) {
			OnError(hr);
			return hr;
		}
		ComPtr<IDXGIKeyedMutex> keyed_mutex;
		const bool has_keyed_mutex =
				SUCCEEDED(resource.As(&keyed_mutex)) && keyed_mutex;
		if (has_keyed_mutex) {
			hr = keyed_mutex->AcquireSync(0, 16);
			if (hr == static_cast<HRESULT>(WAIT_TIMEOUT)) {
				return 1; // browser 正在使用纹理；丢这一帧，下一帧再试。
			}
			if (FAILED(hr)) {
				OnError(hr);
				return hr;
			}
		}
		context_->CopySubresourceRegion(
				destination.Get(),
				0,
				0,
				0,
				0,
				source,
				D3D11CalcSubresource(0, array_index, 1),
				nullptr);
		// 新 TextureStream/新目标纹理的前几帧：确保 GPU 复制完成后再释放 keyed
		// mutex，否则浏览器可能先采样到未写完的 NV12（UV=0 → 绿屏闪烁）。
		if (submitted_frames_ < 4) {
			context_->Flush();
		}
		if (has_keyed_mutex) keyed_mutex->ReleaseSync(0);
		hr = target->put_Timestamp(timestamp_us);
		if (FAILED(hr)) {
			OnError(hr);
			return hr;
		}
		hr = stream_->PresentTexture(target.Get());
		if (FAILED(hr)) {
			OnError(hr);
			return hr;
		}
		last_timestamp_ = timestamp_us;
		++submitted_frames_;
		return 0;
	}

	int SubmitNV12(
			ID3D11Texture2D *source,
			uint32_t array_index,
			uint32_t width,
			uint32_t height,
			uint64_t timestamp_us) {
		if (source == nullptr || width == 0 || height == 0) {
			return E_INVALIDARG;
		}
		if (dispatch_hwnd_ != nullptr &&
				GetCurrentThreadId() != dispatch_thread_id_) {
			auto *request = new SubmitRequest();
			request->state = shared_from_this();
			request->source = source;
			request->array_index = array_index;
			request->width = width;
			request->height = height;
			request->timestamp_us = timestamp_us;
			request->done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
			if (request->done == nullptr) {
				delete request;
				return E_FAIL;
			}
			if (!PostMessageW(
						dispatch_hwnd_,
						kDispatchSubmit,
						0,
						reinterpret_cast<LPARAM>(request))) {
				fprintf(stderr, "lull_media: PostMessage submit failed err=%lu\n",
						static_cast<unsigned long>(GetLastError()));
				CloseHandle(request->done);
				delete request;
				return E_FAIL;
			}
			const DWORD wait = WaitForSingleObject(request->done, INFINITE);
			if (wait != WAIT_OBJECT_0) {
				fprintf(stderr, "lull_media: submit wait failed %lu\n",
						static_cast<unsigned long>(wait));
				return E_FAIL;
			}
			const int result = request->result;
			CloseHandle(request->done);
			delete request;
			return result;
		}
		return SubmitNV12OnUi(source, array_index, width, height, timestamp_us);
	}

	void Shutdown() {
		if (dispatch_hwnd_ != nullptr &&
				GetCurrentThreadId() != dispatch_thread_id_) {
			state_.store(kStateStopped, std::memory_order_release);
			auto *holder = new std::shared_ptr<StreamState>(shared_from_this());
			if (!PostMessageW(
						dispatch_hwnd_,
						kDispatchShutdown,
						0,
						reinterpret_cast<LPARAM>(holder))) {
				fprintf(stderr, "lull_media: PostMessage shutdown failed err=%lu\n",
						static_cast<unsigned long>(GetLastError()));
				delete holder;
				ShutdownOnUi();
			}
			return;
		}
		ShutdownOnUi();
	}

	/** 必须在 WebView2 UI 线程调用。 */
	void ShutdownOnUi() {
		std::lock_guard<std::mutex> lock(mutex_);
		if (stream_) {
			const int state = state_.load(std::memory_order_acquire);
			fprintf(stderr, "lull_media: stream shutdown state=%d\n", state);
			if (start_token_.value != 0) stream_->remove_StartRequested(start_token_);
			if (stop_token_.value != 0) stream_->remove_Stopped(stop_token_);
			if (error_token_.value != 0) stream_->remove_ErrorReceived(error_token_);
			CloseTexturesLocked();
			if (state == kStateStarted) stream_->Stop();
			stream_.Reset();
		}
		start_handler_.Reset();
		stop_handler_.Reset();
		error_handler_.Reset();
		context_.Reset();
		device_.Reset();
		state_.store(kStateStopped, std::memory_order_release);
		if (dispatch_hwnd_ != nullptr) {
			SetWindowLongPtrW(dispatch_hwnd_, GWLP_USERDATA, 0);
			DestroyWindow(dispatch_hwnd_);
			dispatch_hwnd_ = nullptr;
		}
	}

private:
	bool TextureMatches(
			ICoreWebView2ExperimentalTexture *texture,
			uint32_t width,
			uint32_t height) const {
		if (!texture) return false;
		ComPtr<IUnknown> resource;
		if (FAILED(texture->get_Resource(&resource)) || !resource) return false;
		ComPtr<ID3D11Texture2D> surface;
		if (FAILED(resource.As(&surface)) || !surface) return false;
		D3D11_TEXTURE2D_DESC desc{};
		surface->GetDesc(&desc);
		return desc.Format == DXGI_FORMAT_NV12 && desc.Width == width && desc.Height == height;
	}

	void CloseTexturesLocked() {
		if (!stream_) {
			textures_.clear();
			return;
		}
		for (const auto &texture : textures_) {
			if (texture) stream_->CloseTexture(texture.Get());
		}
		textures_.clear();
	}

	std::mutex mutex_;
	ComPtr<ICoreWebView2ExperimentalTextureStream> stream_;
	ComPtr<ID3D11Device> device_;
	ComPtr<ID3D11DeviceContext> context_;
	ComPtr<StartHandler> start_handler_;
	ComPtr<StopHandler> stop_handler_;
	ComPtr<ErrorHandler> error_handler_;
	EventRegistrationToken start_token_{};
	EventRegistrationToken stop_token_{};
	EventRegistrationToken error_token_{};
	std::vector<ComPtr<ICoreWebView2ExperimentalTexture>> textures_;
	uint32_t width_ = 0;
	uint32_t height_ = 0;
	uint64_t last_timestamp_ = 0;
	std::atomic<int> state_{kStateCreated};
	std::atomic<long> last_error_{S_OK};
	bool not_started_logged_ = false;
	bool started_logged_ = false;
	int submitted_frames_ = 0;
	HWND dispatch_hwnd_ = nullptr;
	DWORD dispatch_thread_id_ = 0;
};

LRESULT CALLBACK DispatchWndProc(
		HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
	auto *state = reinterpret_cast<StreamState *>(
			GetWindowLongPtrW(hwnd, GWLP_USERDATA));
	if (state != nullptr && message == kDispatchSubmit) {
		auto *request = reinterpret_cast<StreamState::SubmitRequest *>(lparam);
		request->result = state->SubmitNV12OnUi(
				request->source,
				request->array_index,
				request->width,
				request->height,
				request->timestamp_us);
		SetEvent(request->done);
		return 0;
	}
	if (state != nullptr && message == kDispatchShutdown) {
		auto *holder =
				reinterpret_cast<std::shared_ptr<StreamState> *>(lparam);
		(*holder)->ShutdownOnUi();
		delete holder;
		return 0;
	}
	return DefWindowProcW(hwnd, message, wparam, lparam);
}

HRESULT STDMETHODCALLTYPE StartHandler::Invoke(
		ICoreWebView2ExperimentalTextureStream *,
		IUnknown *) {
	if (auto state = state_.lock()) state->OnStarted();
	return S_OK;
}

HRESULT STDMETHODCALLTYPE StopHandler::Invoke(
		ICoreWebView2ExperimentalTextureStream *,
		IUnknown *) {
	if (auto state = state_.lock()) state->OnStopped();
	return S_OK;
}

HRESULT STDMETHODCALLTYPE ErrorHandler::Invoke(
		ICoreWebView2ExperimentalTextureStream *,
		ICoreWebView2ExperimentalTextureStreamErrorReceivedEventArgs *) {
	if (auto state = state_.lock()) state->OnError(E_FAIL);
	return S_OK;
}

std::mutex g_registry_mutex;
std::unordered_map<lull_media_stream_t, std::shared_ptr<StreamState>> g_streams;
// WebView2 156：TextureStream 在 StartRequested 之前析构会在
// EmbeddedBrowserWebView.dll 里 0x80000003 断言崩溃。未启动的流先留到进程退出。
std::vector<std::shared_ptr<StreamState>> g_retired_streams;
lull_media_stream_t g_next_handle = 1;

std::shared_ptr<StreamState> Lookup(lull_media_stream_t handle) {
	std::lock_guard<std::mutex> lock(g_registry_mutex);
	const auto found = g_streams.find(handle);
	return found == g_streams.end() ? nullptr : found->second;
}

} // namespace

extern "C" {

__declspec(dllexport) int lull_media_probe(void *environment, struct lull_media_probe_result *out) {
	EnsureComInitialized();
	if (out != nullptr) {
		*out = {};
	}
	if (environment == nullptr || out == nullptr) {
		return E_POINTER;
	}
	ComPtr<IUnknown> env_unknown(static_cast<IUnknown *>(environment));
	ComPtr<ICoreWebView2ExperimentalEnvironment12> env12;
	HRESULT hr = env_unknown.As(&env12);
	if (FAILED(hr)) {
		return hr;
	}
	UINT64 luid = 0;
	hr = env12->get_RenderAdapterLUID(&luid);
	if (FAILED(hr)) {
		return hr;
	}
	out->abi_version = kAbiVersion;
	out->flags = 0x1 | 0x2; // Environment12 and adapter LUID are available.
	out->adapter_luid = luid;
	return S_OK;
}

__declspec(dllexport) lull_media_stream_t lull_media_stream_create(
		void *environment,
		void *d3d_device,
		const wchar_t *stream_id,
		const wchar_t *origin,
		int *out_hresult) {
	EnsureComInitialized();
	if (out_hresult != nullptr) {
		*out_hresult = E_FAIL;
	}
	if (environment == nullptr || d3d_device == nullptr || stream_id == nullptr ||
			origin == nullptr) {
		if (out_hresult != nullptr) *out_hresult = E_POINTER;
		return 0;
	}
	auto state = std::make_shared<StreamState>();
	const HRESULT hr = state->Initialize(environment, d3d_device, stream_id, origin);
	if (FAILED(hr)) {
		if (out_hresult != nullptr) *out_hresult = hr;
		return 0;
	}
	std::lock_guard<std::mutex> lock(g_registry_mutex);
	const lull_media_stream_t handle = g_next_handle++;
	g_streams.emplace(handle, std::move(state));
	if (out_hresult != nullptr) *out_hresult = S_OK;
	return handle;
}

__declspec(dllexport) int lull_media_stream_state(lull_media_stream_t stream) {
	EnsureComInitialized();
	auto state = Lookup(stream);
	return state ? state->State() : -1;
}

__declspec(dllexport) int lull_media_stream_take_error(lull_media_stream_t stream, int *code) {
	EnsureComInitialized();
	auto state = Lookup(stream);
	if (!state || code == nullptr) return -1;
	*code = state->LastError();
	return 0;
}

__declspec(dllexport) int lull_media_stream_submit_nv12(
		lull_media_stream_t stream,
		void *texture,
		uint32_t array_index,
		uint32_t width,
		uint32_t height,
		uint64_t timestamp_us) {
	EnsureComInitialized();
	auto state = Lookup(stream);
	if (!state) return E_HANDLE;
	return state->SubmitNV12(
			static_cast<ID3D11Texture2D *>(texture), array_index, width, height, timestamp_us);
}

__declspec(dllexport) int lull_media_stream_submit_bgra(
		lull_media_stream_t,
		void *,
		uint32_t,
		uint32_t,
		uint64_t) {
	return E_NOTIMPL;
}

__declspec(dllexport) void lull_media_stream_stop(lull_media_stream_t stream) {
	EnsureComInitialized();
	auto state = Lookup(stream);
	if (state) state->Stop();
}

__declspec(dllexport) void lull_media_stream_destroy(lull_media_stream_t stream) {
	EnsureComInitialized();
	std::shared_ptr<StreamState> state;
	{
		std::lock_guard<std::mutex> lock(g_registry_mutex);
		const auto found = g_streams.find(stream);
		if (found == g_streams.end()) return;
		state = std::move(found->second);
		g_streams.erase(found);
	}
	if (state->State() == kStateCreated) {
		fprintf(stderr, "lull_media: retire unstarted stream until process exit\n");
		std::lock_guard<std::mutex> lock(g_registry_mutex);
		g_retired_streams.push_back(std::move(state));
		return;
	}
	state->Shutdown();
}

} // extern "C"
