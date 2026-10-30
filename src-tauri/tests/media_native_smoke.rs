//! Native media smoke test: FFmpeg + D3D11 decode through media-pp.
//!
//! Ignored by default because it needs a GPU, FFmpeg DLLs on PATH and a sample
//! file. Run with:
//!   LULL_MEDIA_TEST_VIDEO=... cargo test --features native-media --test media_native_smoke -- --ignored
#![cfg(feature = "native-media")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use media_pp::elements::{
  D3d11Gpu, DecodeTarget, FileDemuxer, FrameCounter, Pacer, VideoDecodeBin,
};
use media_pp::pipeline::Pipeline;

#[test]
#[ignore = "needs GPU + FFmpeg DLLs + LULL_MEDIA_TEST_VIDEO"]
fn decodes_a_file_to_d3d11_frames() {
  let Some(path) = std::env::var_os("LULL_MEDIA_TEST_VIDEO") else {
    eprintln!("LULL_MEDIA_TEST_VIDEO not set; skipping");
    return;
  };
  let (source, _streams) = FileDemuxer::open("demux", &path).expect("open file");
  let video = source
    .best(media_pp::ffmpeg::media::Type::Video)
    .expect("video stream");
  let video_index = video.index;
  let gpu = D3d11Gpu::new().expect("D3D11 device");
  let decoder = VideoDecodeBin::open(
    "decoder",
    video.parameters.clone(),
    DecodeTarget::D3d11 {
      gpu,
      downstream_hw_frames: 8,
    },
    None,
  )
  .expect("decoder");
  let (counter, frames) = FrameCounter::new("counter");

  let (pipeline, ()) = Pipeline::new("smoke", source, move |source, ctx| {
    let branch = ctx
      .branch()
      .pipe(decoder)
      .queue("decode", 4)
      .pipe(Pacer::new("pacer"))
      .to(counter)?;
    ctx.attach(source, video_index, branch)?;
    Ok(())
  })
  .expect("pipeline");

  pipeline.run().expect("run");
  std::thread::sleep(Duration::from_millis(1500));
  pipeline.stop();
  let count = frames.get();
  assert!(count > 0, "decoded no frames");
  eprintln!("decoded {count} frames");
}

#[test]
#[ignore = "needs GPU + FFmpeg DLLs + LULL_MEDIA_TEST_VIDEO"]
fn tee_attaches_first_branch_before_run() {
  let Some(path) = std::env::var_os("LULL_MEDIA_TEST_VIDEO") else {
    eprintln!("LULL_MEDIA_TEST_VIDEO not set; skipping");
    return;
  };
  let (source, _streams) = FileDemuxer::open("demux", &path).expect("open file");
  let video = source
    .best(media_pp::ffmpeg::media::Type::Video)
    .expect("video stream");
  let video_index = video.index;
  let gpu = D3d11Gpu::new().expect("D3D11 device");
  let decoder = VideoDecodeBin::open(
    "decoder",
    video.parameters.clone(),
    DecodeTarget::D3d11 {
      gpu,
      downstream_hw_frames: 8,
    },
    None,
  )
  .expect("decoder");
  let (counter, frames) = FrameCounter::new("counter");

  let (pipeline, (_tee,)) = Pipeline::new("tee-smoke", source, move |source, ctx| {
    let (tee_branch, tee) = ctx.tee("tee").build_dynamic()?;
    let branch = ctx
      .branch()
      .pipe(decoder)
      .queue("decode", 4)
      .pipe(Pacer::new("pacer"))
      .to_branch(tee_branch)?;
    ctx.attach(source, video_index, branch)?;
    let display = tee.branch()?.queue("display", 2).to(counter)?;
    tee.attach(display)?;
    Ok((tee,))
  })
  .expect("pipeline");

  pipeline.run().expect("run");
  std::thread::sleep(Duration::from_millis(1500));
  pipeline.stop();
  let count = frames.get();
  assert!(count > 0, "tee branch decoded no frames");
  eprintln!("tee branch decoded {count} frames");
}
