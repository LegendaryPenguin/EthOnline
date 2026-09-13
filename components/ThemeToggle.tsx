"use client";

import { useEffect, useState } from "react";

type Choice = "system" | "dark" | "light";

/**
 * Three states, not two: "system" is a real answer and the default, so a reader who has set
 * their OS to switch at sunset keeps that behaviour until they explicitly override it.
 *
 * The class goes on `<html>`, which is what `app/tokens.css` keys on — `.theme-dark` and
 * `.theme-light` override the `prefers-color-scheme` block.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>("system");

  useEffect(() => {
    const stored = localStorage.getItem("sentinel-theme");
    if (stored === "dark" || stored === "light") setChoice(stored);
  }, []);

  function apply(next: Choice) {
    setChoice(next);
    const root = document.documentElement;
    root.classList.remove("theme-dark", "theme-light");
    if (next === "system") localStorage.removeItem("sentinel-theme");
    else {
      root.classList.add(`theme-${next}`);
      localStorage.setItem("sentinel-theme", next);
    }
  }

  return (
    <fieldset
      className="flex items-center gap-1 rounded-[var(--radius-pill)] border p-0.5 border-[var(--color-border)]"
      // A radio group rather than a cycling button: with a button the reader cannot tell
      // what the next press will do, and screen readers cannot report the other options.
    >
      <legend className="sr-only">Colour theme</legend>
      {(["system", "light", "dark"] as Choice[]).map((option) => (
        <label
          key={option}
          className="cursor-pointer rounded-[var(--radius-pill)] px-2.5 py-1 text-[length:var(--text-micro)] uppercase tracking-wide"
          style={
            choice === option
              ? { background: "var(--color-accent)", color: "var(--color-accent-ink)" }
              : { color: "var(--color-text-muted)" }
          }
        >
          <input
            type="radio"
            name="theme"
            value={option}
            checked={choice === option}
            onChange={() => apply(option)}
            className="sr-only"
          />
          {option}
        </label>
      ))}
    </fieldset>
  );
}
