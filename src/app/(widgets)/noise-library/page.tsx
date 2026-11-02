"use client";

import { NoiseLibraryWindow } from "@/components/library/noise-library-window";
import { WindowShell } from "@/components/window-shell";
import { m } from "@/paraglide/messages";

export default function NoiseLibraryPage() {
  return (
    <WindowShell section={() => m.widget_noise_library_name()} fit={false}>
      <NoiseLibraryWindow />
    </WindowShell>
  );
}
