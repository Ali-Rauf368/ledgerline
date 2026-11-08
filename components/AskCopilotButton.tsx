"use client";

import { Sparkles } from "lucide-react";
import { openCopilot } from "./Copilot";

export function AskCopilotButton({ question, label = "Ask Copilot" }: { question: string; label?: string }) {
  return (
    <button onClick={() => openCopilot(question)} className="btn-ghost shrink-0 px-2.5! py-1.5! text-xs">
      <Sparkles className="size-3.5 text-accent" /> {label}
    </button>
  );
}
