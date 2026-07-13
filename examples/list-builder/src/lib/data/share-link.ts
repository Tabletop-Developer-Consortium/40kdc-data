/**
 * Backend-free list sharing: a roster encoded into a URL hash fragment. The
 * payload is canonical roster-json, gzipped and base64url-encoded — the same
 * `base64(gzip(json))` shape the package uses for ListForge links, so it stays
 * small and round-trips losslessly back through the importer.
 *
 * `#list=<token>` carries the whole list; opening the link decodes it with no
 * server. Browser-only (btoa/atob); fflate is already a dependency.
 */
import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";
import { encodeShareToken } from "@alpaca-software/40kdc-data";
import { builderStateToShareList, type BuilderState } from "./builder";

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  // chunked to avoid arg-count limits on very large rosters
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(token: string): Uint8Array {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** roster-json text → URL-safe compressed token for a `#list=` fragment. */
export function encodeShareLink(rosterJson: string): string {
  return bytesToBase64url(gzipSync(strToU8(rosterJson)));
}

/** Compressed token → roster-json text, or null on any malformed input. */
export function decodeShareLink(token: string): string | null {
  try {
    return strFromU8(gunzipSync(base64urlToBytes(token)));
  } catch {
    return null;
  }
}

export type CompactShareLinkResult =
	| { ok: true; link: string }
	| { ok: false; error: string };

/** Encodes a builder draft into a compact share URL without leaking codec errors into the UI. */
export function tryEncodeCompactShareLink(
	state: BuilderState,
	baseUrl: string,
): CompactShareLinkResult {
	try {
		return { ok: true, link: `${baseUrl}#l=${encodeShareToken(builderStateToShareList(state))}` };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Couldn’t create a share link.",
		};
	}
}
