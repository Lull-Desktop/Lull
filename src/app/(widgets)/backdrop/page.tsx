"use client";

import { WallpaperLibraryWindow } from "@/components/library/wallpaper-library-window";
import { WindowShell } from "@/components/window-shell";
import { m } from "@/paraglide/messages";

export default function BackdropPage() {
  return (
    <WindowShell section={() => m.widget_backdrop_name()} fit={false}>
      <WallpaperLibraryWindow />
    </WindowShell>
  );
}
