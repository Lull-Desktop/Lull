// C ABI for Lull's WebView2 texture-stream media bridge.
//
// The bridge owns only WebView2 TextureStream objects, target texture pools and
// GPU copies. media-pp owns decode; Rust owns the session/pipeline. A stream
// handle is an opaque u64; no COM pointer crosses the ABI except the borrowed
// environment/device/texture pointers passed for the duration of one call.

#pragma once

#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

typedef uint64_t lull_media_stream_t;

struct lull_media_probe_result {
	uint32_t abi_version;
	uint32_t flags; // bit0 Environment12, bit1 adapter LUID, bit2 stream creatable
	uint64_t adapter_luid;
};

// Called with Tauri's ICoreWebView2Environment as `environment` (IUnknown*).
// Returns S_OK when Environment12 is available; flags describe what worked.
__declspec(dllexport) int lull_media_probe(void *environment, struct lull_media_probe_result *out);

// Creates one TextureStream. `d3d_device` is an ID3D11Device*; the environment
// is the window's ICoreWebView2Environment. The returned handle is 0 on failure
// and `*out_hresult` carries the HRESULT. `stream_id`/`origin` are UTF-16.
__declspec(dllexport) lull_media_stream_t lull_media_stream_create(
		void *environment,
		void *d3d_device,
		const wchar_t *stream_id,
		const wchar_t *origin,
		int *out_hresult);

// 0 created, 1 started, 2 stopped, 3 error, 4 adapter lost, -1 invalid handle.
__declspec(dllexport) int lull_media_stream_state(lull_media_stream_t stream);

// Copies the last error HRESULT; returns 0 on success, -1 for invalid handle.
__declspec(dllexport) int lull_media_stream_take_error(lull_media_stream_t stream, int *code);

// `texture` is an ID3D11Texture2D* borrowed for this call only. Returns 0 when
// the frame was presented or intentionally dropped (not started/no texture
// available), or a negative HRESULT on failure.
__declspec(dllexport) int lull_media_stream_submit_nv12(
		lull_media_stream_t stream,
		void *texture,
		uint32_t array_index,
		uint32_t width,
		uint32_t height,
		uint64_t timestamp_us);

// Reserved: WebView2 TextureStream currently takes NV12 only.
__declspec(dllexport) int lull_media_stream_submit_bgra(
		lull_media_stream_t stream,
		void *texture,
		uint32_t width,
		uint32_t height,
		uint64_t timestamp_us);

__declspec(dllexport) void lull_media_stream_stop(lull_media_stream_t stream);
__declspec(dllexport) void lull_media_stream_destroy(lull_media_stream_t stream);

#ifdef __cplusplus
}
#endif
