/**
 * 单测/预览用的内存传输。handler 返回 result；抛 LullMediaError 会转成错误响应。
 */

import { LullMediaError } from "./errors";
import {
  MEDIA_PROTOCOL,
  type MediaRequest,
  type MediaResponse,
} from "./protocol";
import type { MediaTransport } from "./transport";

export type MemoryMediaHandler = (
  request: MediaRequest,
) => unknown | Promise<unknown>;

export interface MemoryMediaTransport extends MediaTransport {
  readonly requests: MediaRequest[];
}

export function createMemoryTransport(
  handler: MemoryMediaHandler,
): MemoryMediaTransport {
  const requests: MediaRequest[] = [];
  return {
    requests,
    async call(request: MediaRequest): Promise<MediaResponse> {
      requests.push(request);
      try {
        const result = await Promise.resolve(handler(request));
        return {
          protocol: MEDIA_PROTOCOL,
          requestId: request.requestId,
          ok: true,
          result,
          revision: 0,
        };
      } catch (error) {
        if (error instanceof LullMediaError) {
          return {
            protocol: MEDIA_PROTOCOL,
            requestId: request.requestId,
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
            revision: 0,
          };
        }
        throw error;
      }
    },
  };
}
