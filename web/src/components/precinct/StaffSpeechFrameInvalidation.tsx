import { useThree } from "@react-three/fiber";
import { useLayoutEffect } from "react";
/** Schedule a final existing-Canvas frame on stop/mute/pause so the last open mouth cannot freeze. */
export function StaffSpeechFrameInvalidation({ moving }: { readonly moving: boolean }) {
  const invalidate = useThree((state) => state.invalidate);
  useLayoutEffect(() => { invalidate(); }, [moving, invalidate]);
  return null;
}
