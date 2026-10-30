// Minimal WebView2 TextureStream declarations for Lull's native media bridge.
//
// Extracted from Microsoft.Web.WebView2 1.0.4312-prerelease (WebView2Experimental.h)
// so the repository does not need the NuGet package at build time. The interfaces
// and vtable order must match the SDK exactly; the IIDs below are copied from it.
// Copyright (C) Microsoft Corporation. Use is subject to the WebView2 SDK license.

#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <eventtoken.h>
#include <unknwn.h>
#include <d3d11.h>
#include <dxgi1_2.h>

struct ICoreWebView2ExperimentalTexture;
struct ICoreWebView2ExperimentalTextureStream;
struct ICoreWebView2ExperimentalTextureStreamErrorReceivedEventArgs;
struct ICoreWebView2ExperimentalTextureStreamErrorReceivedEventHandler;
struct ICoreWebView2ExperimentalTextureStreamStartRequestedEventHandler;
struct ICoreWebView2ExperimentalTextureStreamStoppedEventHandler;
struct ICoreWebView2ExperimentalRenderAdapterLUIDChangedEventHandler;

// Texture: one shared NV12 surface the host writes and WebView2 renders.
MIDL_INTERFACE("0836f09c-34bd-47bf-914a-99fb56ae2d07")
ICoreWebView2ExperimentalTexture : public IUnknown {
	virtual HRESULT STDMETHODCALLTYPE get_Handle(HANDLE *value) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_Resource(IUnknown **value) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_Timestamp(UINT64 *value) = 0;
	virtual HRESULT STDMETHODCALLTYPE put_Timestamp(UINT64 value) = 0;
};

// The JS side calls chrome.webview.getTextureStream(id); StartRequested fires
// when it does, and Stopped when the track is stopped.
MIDL_INTERFACE("62d09330-00a9-41bf-a9ae-55aaef8b3c44")
ICoreWebView2ExperimentalTextureStreamStartRequestedEventHandler : public IUnknown {
	virtual HRESULT STDMETHODCALLTYPE Invoke(
			ICoreWebView2ExperimentalTextureStream *sender, IUnknown *args) = 0;
};

MIDL_INTERFACE("4111102a-d19f-4438-af46-efc563b2b9cf")
ICoreWebView2ExperimentalTextureStreamStoppedEventHandler : public IUnknown {
	virtual HRESULT STDMETHODCALLTYPE Invoke(
			ICoreWebView2ExperimentalTextureStream *sender, IUnknown *args) = 0;
};

MIDL_INTERFACE("0e1730c1-03df-4ad2-b847-be4d63adf700")
ICoreWebView2ExperimentalTextureStreamErrorReceivedEventArgs : public IUnknown {
	// COREWEBVIEW2_TEXTURE_STREAM_ERROR_KIND is an int-sized enum.
	virtual HRESULT STDMETHODCALLTYPE get_Kind(int *value) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_Texture(ICoreWebView2ExperimentalTexture **value) = 0;
};

MIDL_INTERFACE("52cb8898-c711-401a-8f97-3646831ba72d")
ICoreWebView2ExperimentalTextureStreamErrorReceivedEventHandler : public IUnknown {
	virtual HRESULT STDMETHODCALLTYPE Invoke(
			ICoreWebView2ExperimentalTextureStream *sender,
			ICoreWebView2ExperimentalTextureStreamErrorReceivedEventArgs *args) = 0;
};

// Minimal event handler for the unused adapter-change notification. Declared so
// the Environment12 vtable has the same shape as the SDK.
MIDL_INTERFACE("431721e0-0f18-4d7b-bd4d-e5b1522bb110")
ICoreWebView2ExperimentalRenderAdapterLUIDChangedEventHandler : public IUnknown {
	virtual HRESULT STDMETHODCALLTYPE Invoke(
			IUnknown *sender, IUnknown *args) = 0;
};

// Environment12: the only interface that can create a TextureStream. It must be
// queried from the ICoreWebView2Environment Tauri gives us.
MIDL_INTERFACE("96c27a45-f142-4873-80ad-9d0cd899b2b9")
ICoreWebView2ExperimentalEnvironment12 : public IUnknown {
	virtual HRESULT STDMETHODCALLTYPE CreateTextureStream(
			LPCWSTR streamId,
			IUnknown *d3dDevice,
			ICoreWebView2ExperimentalTextureStream **value) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_RenderAdapterLUID(UINT64 *value) = 0;
	virtual HRESULT STDMETHODCALLTYPE add_RenderAdapterLUIDChanged(
			ICoreWebView2ExperimentalRenderAdapterLUIDChangedEventHandler *eventHandler,
			EventRegistrationToken *token) = 0;
	virtual HRESULT STDMETHODCALLTYPE remove_RenderAdapterLUIDChanged(
			EventRegistrationToken token) = 0;
};

// Full vtable order matters even though Lull only calls a subset. Parameter
// types of the unused WebTexture events are irrelevant because they are never
// called; keeping the slots preserves ABI layout.
MIDL_INTERFACE("afca8431-633f-4528-abfe-7fc3bedd8962")
ICoreWebView2ExperimentalTextureStream : public IUnknown {
	virtual HRESULT STDMETHODCALLTYPE get_Id(LPWSTR *value) = 0;
	virtual HRESULT STDMETHODCALLTYPE AddAllowedOrigin(LPCWSTR origin, BOOL value) = 0;
	virtual HRESULT STDMETHODCALLTYPE RemoveAllowedOrigin(LPCWSTR origin) = 0;
	virtual HRESULT STDMETHODCALLTYPE add_StartRequested(
			ICoreWebView2ExperimentalTextureStreamStartRequestedEventHandler *eventHandler,
			EventRegistrationToken *token) = 0;
	virtual HRESULT STDMETHODCALLTYPE remove_StartRequested(EventRegistrationToken token) = 0;
	virtual HRESULT STDMETHODCALLTYPE add_Stopped(
			ICoreWebView2ExperimentalTextureStreamStoppedEventHandler *eventHandler,
			EventRegistrationToken *token) = 0;
	virtual HRESULT STDMETHODCALLTYPE remove_Stopped(EventRegistrationToken token) = 0;
	virtual HRESULT STDMETHODCALLTYPE CreateTexture(
			UINT32 widthInTexels, UINT32 heightInTexels,
			ICoreWebView2ExperimentalTexture **texture) = 0;
	virtual HRESULT STDMETHODCALLTYPE GetAvailableTexture(
			ICoreWebView2ExperimentalTexture **texture) = 0;
	virtual HRESULT STDMETHODCALLTYPE CloseTexture(ICoreWebView2ExperimentalTexture *texture) = 0;
	virtual HRESULT STDMETHODCALLTYPE PresentTexture(ICoreWebView2ExperimentalTexture *texture) = 0;
	virtual HRESULT STDMETHODCALLTYPE Stop(void) = 0;
	virtual HRESULT STDMETHODCALLTYPE add_ErrorReceived(
			ICoreWebView2ExperimentalTextureStreamErrorReceivedEventHandler *eventHandler,
			EventRegistrationToken *token) = 0;
	virtual HRESULT STDMETHODCALLTYPE remove_ErrorReceived(EventRegistrationToken token) = 0;
	virtual HRESULT STDMETHODCALLTYPE SetD3DDevice(IUnknown *d3dDevice) = 0;
	virtual HRESULT STDMETHODCALLTYPE add_WebTextureReceived(IUnknown *eventHandler,
			EventRegistrationToken *token) = 0;
	virtual HRESULT STDMETHODCALLTYPE remove_WebTextureReceived(EventRegistrationToken token) = 0;
	virtual HRESULT STDMETHODCALLTYPE add_WebTextureStreamStopped(IUnknown *eventHandler,
			EventRegistrationToken *token) = 0;
	virtual HRESULT STDMETHODCALLTYPE remove_WebTextureStreamStopped(EventRegistrationToken token) = 0;
};
