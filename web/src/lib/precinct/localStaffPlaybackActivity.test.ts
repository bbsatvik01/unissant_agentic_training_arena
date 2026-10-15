import { describe, expect, it, vi } from "vitest";
import { createLocalStaffPlaybackActivity, staffSpeechNeedsFrames } from "./localStaffPlaybackActivity";
describe("existing Canvas staff playback activity", () => {
  it("notifies only changed audio state and releases subscriptions", () => {
    const store = createLocalStaffPlaybackActivity(); const listener = vi.fn(); const unsubscribe = store.subscribe(listener);
    expect(store.getSnapshot()).toBe(false); store.set(false); expect(listener).not.toHaveBeenCalled();
    store.set(true); store.set(true); expect(listener).toHaveBeenCalledTimes(1); expect(store.getSnapshot()).toBe(true);
    expect(store.getServerSnapshot()).toBe(false); store.set(false); expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe(); store.set(true); expect(listener).toHaveBeenCalledTimes(2);
  });
  it("requests ongoing frames only for actual unmuted playback, never paused/reduced/replayed lips", () => {
    expect(staffSpeechNeedsFrames(true, false, false, false)).toBe(true);
    expect(staffSpeechNeedsFrames(false, false, false, false)).toBe(false);
    expect(staffSpeechNeedsFrames(true, true, false, false)).toBe(false);
    expect(staffSpeechNeedsFrames(true, false, true, false)).toBe(false);
    expect(staffSpeechNeedsFrames(true, false, false, true)).toBe(false);
  });
});
