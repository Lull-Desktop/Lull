"use client";

import { createContext, type ReactNode, useContext } from "react";

import type { LullMediaClient } from "./client";
import { bindMediaClientHook } from "./hooks";

export {
  useNoiseLibrary,
  useNoisePresets,
  useNoiseSession,
  useNoiseTracks,
  type NoiseLibraryState,
  type NoisePresetsState,
} from "./hooks";

const MediaClientContext = createContext<LullMediaClient | null>(null);

export function LullMediaProvider({
  client,
  children,
}: {
  client: LullMediaClient;
  children: ReactNode;
}) {
  return (
    <MediaClientContext.Provider value={client}>
      {children}
    </MediaClientContext.Provider>
  );
}

export function useMediaClient(): LullMediaClient {
  const client = useContext(MediaClientContext);
  if (!client) {
    throw new Error("useMediaClient 必须在 LullMediaProvider 内使用");
  }
  return client;
}

bindMediaClientHook(useMediaClient);
