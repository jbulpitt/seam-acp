import { describe, expect, it } from "vitest";
import {
  LiveHelpSpeechGate,
  pcm16Rms,
} from "../packages/core/src/platforms/discord/live-help-call.js";

function frame(amplitude: number, samples = 320): Buffer {
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return out;
}

describe("Live Help local speech gate", () => {
  it("measures PCM energy", () => {
    expect(pcm16Rms(Buffer.alloc(640))).toBe(0);
    expect(pcm16Rms(frame(1_000))).toBeCloseTo(1_000, 5);
  });

  it("hard-drops audio while the Discord member is muted", () => {
    const gate = new LiveHelpSpeechGate(true);
    for (let i = 0; i < 20; i++) {
      expect(gate.push(frame(5_000))).toEqual({ started: false, pcm: [] });
    }
    expect(gate.isActive).toBe(false);
  });

  it("does not treat unmute itself as speech", () => {
    const gate = new LiveHelpSpeechGate(true);
    expect(gate.setMuted(false)).toBe(false);
    expect(gate.isActive).toBe(false);
  });

  it("ignores silence, comfort noise, and a single noisy packet while unmuted", () => {
    const gate = new LiveHelpSpeechGate(false);
    for (let i = 0; i < 20; i++) {
      expect(gate.push(frame(100))).toEqual({ started: false, pcm: [] });
    }
    expect(gate.push(frame(8_000))).toEqual({ started: false, pcm: [] });
    expect(gate.push(frame(100))).toEqual({ started: false, pcm: [] });
    expect(gate.isActive).toBe(false);
  });

  it("confirms sustained speech and releases its pre-roll exactly once", () => {
    const gate = new LiveHelpSpeechGate(false);
    for (let i = 0; i < 7; i++) {
      expect(gate.push(frame(4_000)).started).toBe(false);
    }
    const confirmed = gate.push(frame(4_000));
    expect(confirmed.started).toBe(true);
    expect(confirmed.pcm).toHaveLength(8);
    expect(gate.isActive).toBe(true);

    const continuation = gate.push(frame(3_000));
    expect(continuation.started).toBe(false);
    expect(continuation.pcm).toHaveLength(1);
  });

  it("allows early unmute and silent waiting before later confirmed speech", () => {
    const gate = new LiveHelpSpeechGate(true);
    gate.setMuted(false);
    for (let i = 0; i < 50; i++) gate.push(frame(80));
    expect(gate.isActive).toBe(false);
    for (let i = 0; i < 7; i++) expect(gate.push(frame(2_000)).started).toBe(false);
    expect(gate.push(frame(2_000)).started).toBe(true);
  });

  it("ends an active utterance on mute and requires fresh speech after re-unmute", () => {
    const gate = new LiveHelpSpeechGate(false);
    for (let i = 0; i < 8; i++) gate.push(frame(4_000));
    expect(gate.isActive).toBe(true);
    expect(gate.setMuted(true)).toBe(true);
    expect(gate.isActive).toBe(false);
    expect(gate.push(frame(4_000))).toEqual({ started: false, pcm: [] });
    expect(gate.setMuted(false)).toBe(false);
    expect(gate.isActive).toBe(false);
  });
});
