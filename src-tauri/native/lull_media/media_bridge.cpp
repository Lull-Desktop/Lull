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

// WebView2 clears every texture it handed out when the stream stops, so the
// host must drop its references and register them again after the next
// `StartRequested`. Keeping more than a handful of 4K NV12 targets alive is
// never useful: the renderer only needs one per in-flight composition.
constexpr uint32_t kMaxTextures = 8;
// A local D3D11/WebView2 call can fail once while the compositor is between
// states. Treating the first failure as fatal killed the stream until a new
// `getTextureStream`; a short run of failures is a real break.
constexpr uint32_t kMaxConsecutiveLocalErrors = 30;
constexpr uint64_t kDropLogIntervalMs = 5'000;
// COREWEBVIEW2_TEXTURE_STREAM_ERROR_KIND values (int-sized enum).
constexpr int kErrorBufferNotFound = 2;
constexpr int kErrorBufferInUse = 3;

/** 记录一次可能在 WebView2 UI 线程上阻塞的调用；超过阈值才写日志。 */
class SlowCallLog {
public:
	SlowCallLog(const char *what, DWORD threshold_ms)
			: what_(what), threshold_(threshold_ms), start_(GetTickCount()) {}
	~SlowCallLog() {
		const DWORD elapsed = GetTickCount() - start_;
		if (elapsed > threshold_) {
			fprintf(stderr, "lull_media: %s took %lu ms\n", what_,
					static_cast<unsigned long>(elapsed));
		}
	}
	SlowCallLog(const SlowCallLog &) = delete;
	SlowCallLog &operator=(const SlowCallLog &) = delete;

private:
	const char *what_;
	DWORD threshold_;
	DWORD start_;
};

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
		const int previous = state_.exchange(kStateStarted, std::memory_order_acq_rel);
		if (previous == kStateCreated) {
			fprintf(stderr, "lull_media: StartRequested\n");
		} else {
			// The page called getTextureStream again after a stop: the browser
			// has already dropped every texture we registered.
			fprintf(stderr, "lull_media: StartRequested again (was state=%d)\n", previous);
			textures_stale_.store(true, std::memory_order_release);
		}
		not_started_logged_.store(false, std::memory_order_release);
	}

	void OnStopped() {
		fprintf(stderr, "lull_media: Stopped (state=%d)\n", State());
		// Everything WebView2 handed out is gone; re-register after a restart.
		textures_stale_.store(true, std::memory_order_release);
		state_.store(kStateStopped, std::memory_order_release);
	}

	/**
	 * Async `ErrorReceived`. The SDK defines buffer-not-found and
	 * buffer-in-use as transient conditions of the presentation queue, not as
	 * stream failures; treating them as fatal is what left the wallpaper black
	 * until the page re-attached.
	 */
	void OnErrorKind(int kind) {
		last_error_kind_.store(static_cast<uint32_t>(kind), std::memory_order_release);
		if (kind == kErrorBufferNotFound || kind == kErrorBufferInUse) {
			transient_errors_.fetch_add(1, std::memory_order_relaxed);
			return;
		}
		fprintf(stderr, "lull_media: stream error kind=%d\n", kind);
		last_error_.store(E_FAIL, std::memory_order_release);
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
		textures_stale_.store(true, std::memory_order_release);
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

	/**
	 * 必须在 WebView2 UI 线程调用。
	 *
	 * Returns 0 presented, 1 stream not started (JS has not asked yet, or the
	 * browser stopped it), 2 no writable target this frame (all textures in
	 * use, or the keyed mutex was busy), negative HRESULT on a local failure.
	 * The source texture is borrowed for this call only.
	 */
	int SubmitNV12OnUi(
			ID3D11Texture2D *source,
			uint32_t array_index,
			uint32_t width,
			uint32_t height,
			uint64_t timestamp_us) {
		// 解码线程在等这一次调用；它一旦慢，另一屏也会跟着停帧。
		SlowCallLog slow("submit_nv12_on_ui", 30);
		if (source == nullptr || width == 0 || height == 0) {
			return E_INVALIDARG;
		}
		std::lock_guard<std::mutex> lock(mutex_);
		if (!stream_ || !context_) {
			return E_HANDLE;
		}
		// After a stop the browser has dropped every texture it handed out.
		// Reusing those COM refs after a restart presents nothing.
		if (textures_stale_.exchange(false, std::memory_order_acq_rel)) {
			textures_.clear();
			texture_count_.store(0, std::memory_order_relaxed);
			width_ = 0;
			height_ = 0;
			started_logged_ = false;
		}
		if (state_.load(std::memory_order_acquire) != kStateStarted) {
			dropped_not_started_.fetch_add(1, std::memory_order_relaxed);
			if (!not_started_logged_.exchange(true, std::memory_order_acq_rel)) {
				fprintf(stderr,
						"lull_media: frame while stream state=%d (dropped)\n",
						State());
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
			if (texture_count_.load(std::memory_order_relaxed) >= kMaxTextures) {
				// The renderer has not returned a texture, so it is not
				// compositing (hidden/occluded window, stalled renderer).
				// Allocating another 4K NV12 target every frame is what turns
				// that pause into GPU memory pressure.
				dropped_no_texture_.fetch_add(1, std::memory_order_relaxed);
				LogDropLocked("no available texture", texture_count_.load(std::memory_order_relaxed));
				return 2;
			}
			hr = stream_->CreateTexture(width, height, &target);
			if (FAILED(hr)) {
				if (hr == static_cast<HRESULT>(HRESULT_FROM_WIN32(ERROR_NO_MORE_ITEMS))) {
					dropped_no_texture_.fetch_add(1, std::memory_order_relaxed);
					return 2;
				}
				return LocalFailureLocked(hr);
			}
			textures_.push_back(target);
			texture_count_.store(static_cast<uint32_t>(textures_.size()), std::memory_order_relaxed);
			created_textures_.fetch_add(1, std::memory_order_relaxed);
			if (static_cast<uint32_t>(textures_.size()) > 3u) {
				LogDropLocked("texture pool grew", texture_count_.load(std::memory_order_relaxed));
			}
			if (!TextureMatches(target.Get(), width, height)) {
				return LocalFailureLocked(E_FAIL);
			}
		}

		ComPtr<IUnknown> resource;
		hr = target->get_Resource(&resource);
		if (FAILED(hr)) {
			return LocalFailureLocked(hr);
		}
		ComPtr<ID3D11Texture2D> destination;
		hr = resource.As(&destination);
		if (FAILED(hr)) {
			return LocalFailureLocked(hr);
		}
		ComPtr<IDXGIKeyedMutex> keyed_mutex;
		const bool has_keyed_mutex =
				SUCCEEDED(resource.As(&keyed_mutex)) && keyed_mutex;
		if (has_keyed_mutex) {
			hr = keyed_mutex->AcquireSync(0, 16);
			if (hr == static_cast<HRESULT>(WAIT_TIMEOUT)) {
				dropped_no_texture_.fetch_add(1, std::memory_order_relaxed);
				return 2; // browser 正在使用纹理；丢这一帧，下一帧再试。
			}
			if (FAILED(hr)) {
				return LocalFailureLocked(hr);
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
			return LocalFailureLocked(hr);
		}
		hr = stream_->PresentTexture(target.Get());
		if (FAILED(hr)) {
			return LocalFailureLocked(hr);
		}
		last_timestamp_ = timestamp_us;
		++submitted_frames_;
		consecutive_local_errors_ = 0;
		presented_.fetch_add(1, std::memory_order_relaxed);
		last_present_tick_ms_.store(GetTickCount64(), std::memory_order_relaxed);
		return 0;
	}

	/** Copy of the counters, safe from any thread. */
	void Stats(struct lull_media_stream_stats *out) const {
		if (out == nullptr) {
			return;
		}
		out->abi_version = kAbiVersion;
		out->state = state_.load(std::memory_order_acquire);
		out->texture_count = texture_count_.load(std::memory_order_relaxed);
		out->last_error_kind = last_error_kind_.load(std::memory_order_relaxed);
		out->presented = presented_.load(std::memory_order_relaxed);
		out->dropped_not_started = dropped_not_started_.load(std::memory_order_relaxed);
		out->dropped_no_texture = dropped_no_texture_.load(std::memory_order_relaxed);
		out->created_textures = created_textures_.load(std::memory_order_relaxed);
		out->transient_errors = transient_errors_.load(std::memory_order_relaxed);
		const uint64_t last_present = last_present_tick_ms_.load(std::memory_order_relaxed);
		out->last_present_tick_ms = last_present;
		const uint64_t now = GetTickCount64();
		out->since_last_present_ms =
				(last_present != 0 && now > last_present) ? (now - last_present) : 0;
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
			const DWORD wait_started = GetTickCount();
			const DWORD wait = WaitForSingleObject(request->done, INFINITE);
			const DWORD waited_ms = GetTickCount() - wait_started;
			if (waited_ms > 50) {
				// 解码线程被 UI 线程（窗口销毁 / WebView2 关闭）挡住：这就是
				// “关一屏、另一屏黑”最可能的传导路径。
				fprintf(stderr, "lull_media: submit waited %lu ms on UI thread\n",
						static_cast<unsigned long>(waited_ms));
			}
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
		SlowCallLog slow("stream_shutdown_on_ui", 50);
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
			texture_count_.store(0, std::memory_order_relaxed);
			return;
		}
		for (const auto &texture : textures_) {
			if (texture) stream_->CloseTexture(texture.Get());
		}
		textures_.clear();
		texture_count_.store(0, std::memory_order_relaxed);
	}

	/**
	 * A single local D3D11/WebView2 failure is not a dead stream: the
	 * compositor can be between states for a frame. Only a sustained run of
	 * failures marks the stream dead, which is what makes the Rust side
	 * re-attach instead of leaving a black surface.
	 */
	int LocalFailureLocked(HRESULT hr) {
		++consecutive_local_errors_;
		const uint32_t failures = consecutive_local_errors_;
		if (failures >= kMaxConsecutiveLocalErrors) {
			fprintf(stderr,
					"lull_media: %u consecutive local failures hr=0x%08lx; stream dead\n",
					failures,
					static_cast<unsigned long>(hr));
			last_error_.store(hr, std::memory_order_release);
			last_error_kind_.store(0xFFFF'FFFFu, std::memory_order_relaxed);
			state_.store(kStateError, std::memory_order_release);
		}
		return hr;
	}

	/** Rate-limited: a stalled stream drops every frame, which must not spam. */
	void LogDropLocked(const char *reason, uint32_t pool) {
		const uint64_t now = GetTickCount64();
		const uint64_t last = last_drop_log_ms_.load(std::memory_order_relaxed);
		if (now - last < kDropLogIntervalMs) {
			return;
		}
		last_drop_log_ms_.store(now, std::memory_order_relaxed);
		fprintf(stderr,
				"lull_media: %s (state=%d pool=%u presented=%llu not_started=%llu "
				"no_texture=%llu created=%llu)\n",
				reason,
				State(),
				pool,
				static_cast<unsigned long long>(presented_.load(std::memory_order_relaxed)),
				static_cast<unsigned long long>(
						dropped_not_started_.load(std::memory_order_relaxed)),
				static_cast<unsigned long long>(
						dropped_no_texture_.load(std::memory_order_relaxed)),
				static_cast<unsigned long long>(
						created_textures_.load(std::memory_order_relaxed)));
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
	std::atomic<uint32_t> last_error_kind_{0};
	std::atomic<bool> textures_stale_{false};
	std::atomic<bool> not_started_logged_{false};
	bool started_logged_ = false; // guarded by mutex_
	int submitted_frames_ = 0;    // guarded by mutex_
	uint32_t consecutive_local_errors_ = 0; // guarded by mutex_
	std::atomic<uint32_t> texture_count_{0};
	std::atomic<uint64_t> presented_{0};
	std::atomic<uint64_t> dropped_not_started_{0};
	std::atomic<uint64_t> dropped_no_texture_{0};
	std::atomic<uint64_t> created_textures_{0};
	std::atomic<uint64_t> transient_errors_{0};
	std::atomic<uint64_t> last_present_tick_ms_{0};
	std::atomic<uint64_t> last_drop_log_ms_{0};
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
		ICoreWebView2ExperimentalTextureStreamErrorReceivedEventArgs *args) {
	int kind = -1;
	if (args != nullptr) {
		args->get_Kind(&kind);
	}
	if (auto state = state_.lock()) state->OnErrorKind(kind);
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

__declspec(dllexport) int lull_media_stream_stats(
		lull_media_stream_t stream, struct lull_media_stream_stats *out) {
	EnsureComInitialized();
	if (out == nullptr) return -1;
	*out = {};
	auto state = Lookup(stream);
	if (!state) return -1;
	state->Stats(out);
	return 0;
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
