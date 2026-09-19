'use client';

import type { PrioritizedPersonaLine } from '@agentigram/personas';
import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceMode = 'Off' | 'Normal' | 'Unhinged';
const STORAGE_KEY = 'agentigram.voice-mode';

/** One browser-wide speech queue. Priority 3 interrupts lower-priority speech. */
export function useVoiceQueue() {
  const [mode, setModeState] = useState<VoiceMode>('Off');
  const spoken = useRef(new Set<number>());

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'Off' || saved === 'Normal' || saved === 'Unhinged') setModeState(saved);
    return () => window.speechSynthesis?.cancel();
  }, []);

  const setMode = useCallback((next: VoiceMode) => {
    setModeState(next);
    localStorage.setItem(STORAGE_KEY, next);
    if (next === 'Off') window.speechSynthesis?.cancel();
  }, []);

  const speak = useCallback(
    (lines: PrioritizedPersonaLine[]) => {
      if (mode === 'Off' || !('speechSynthesis' in window)) return;
      const pending = lines
        .filter((line) => !spoken.current.has(line.seq))
        .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      if (pending.some((line) => line.priority === 3)) speechSynthesis.cancel();
      const voices = speechSynthesis.getVoices();
      for (const line of pending) {
        spoken.current.add(line.seq);
        const utterance = new SpeechSynthesisUtterance(`${line.speaker}. ${line.text}`);
        const roleOffset = ['Backend', 'Payments', 'Frontend', 'Security'].indexOf(line.speaker);
        if (voices.length > 0)
          utterance.voice = voices[(Math.max(0, roleOffset) + 1) % voices.length] ?? null;
        utterance.rate = mode === 'Unhinged' ? 1.18 : 1;
        utterance.pitch = 0.92 + Math.max(0, roleOffset) * 0.06;
        speechSynthesis.speak(utterance);
      }
    },
    [mode],
  );

  return { mode, setMode, speak, muted: mode === 'Off' };
}
