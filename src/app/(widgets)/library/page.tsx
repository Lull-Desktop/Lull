"use client";

import { LibraryWindow } from "@/components/library/library-window";
import { WindowShell } from "@/components/window-shell";
import { m } from "@/paraglide/messages";

export default function LibraryPage() {
  return (
    <WindowShell section={() => m.widget_library_name()} fit={false}>
      <LibraryWindow />
    </WindowShell>
  );
}
