# Gated Notes 🧠

**AI-powered, gated reading and spaced repetition for Obsidian.**

**Gated Notes** is an Obsidian plugin that transforms reading into an active learning process. Inspired by [Andy Matuschak and Michael Nielsen’s concept of the “Mnemonic Medium”](https://numinous.productions/ttft/#introducing-mnemonic-medium), it combines **gated reading** with an **SM-2 spaced repetition system** and **AI-driven flashcard generation**.

Instead of passively consuming information, you must _earn_ your way through a note: later sections remain blurred until you’ve correctly answered flashcards tied to earlier sections.

---

## ✨ Key Features

-   **Gated Reading:** Locks later paragraphs in a note until you’ve mastered the flashcards for the current section. When you unlock new content, the plugin **automatically scrolls to it and highlights it**.

-   🖼️ **Multimodal AI:**
    -   **Contextual Image Analysis:** Automatically analyzes images, using surrounding text to understand diagrams, charts, and photos. It extracts key facts and context, not just visual elements.
    -   **Smarter Card Generation:** Creates flashcards that test factual knowledge *from* diagrams (`key_facts`) or ask visual questions that require seeing the image.
    -   **Intelligent Tagging:** Links image-based cards directly to the source image for quick context-jumping.

-   **AI-Powered Flashcards:** Create cards automatically using OpenAI (including GPT-4o) or a local LM Studio instance.

-   **Advanced AI Tools:**
    -   **Custom Guidance:** Direct the AI during card generation with specific instructions (e.g., "the answer (back) should only be names of people and places or dates").
    -   **Split Card:** Break a complex card into smaller, more atomic ones.
    -   **Refocus Card:** Generate alternate phrasings or "reverse" questions for the same fact.
    -   **Auto-Correct Tags:** If the AI generates a tag that isn't a direct quote, it will automatically attempt to fix it.

-   **Powerful Card Management:**
    -   **Stateful Card Browser:** The browser remembers your scroll position, expanded folders, and last-viewed chapter between sessions.
    -   **Flag Cards:** Mark cards with a 🚩 to easily find and filter them in the Card Browser.
    -   **Suspend Cards:** Temporarily remove cards from review queues and content gating without deleting them.
    -   **Reset Card Progress:** Reset individual cards back to "new" from the edit modal.
    -   **Card Preview:** See how your Markdown will render on the front and back of a card, right from the edit modal.

-   **SM-2 Scheduling:** Built-in spaced repetition ensures maximum retention.

-   **Multiple Study Modes:**
    -   **🎯 Chapter Mode:** Review cards for the current chapter in gated reading.
    -   **📚 Subject Mode:** Review all cards in a subject folder.
    -   **🧠 Review Mode:** Study all due cards vault-wide.

-   **Rich UI Enhancements:**
    -   Status bar due-card counter.
    -   File explorer icons showing chapter status (`⏳` blocked, `📆` due, `✅` done).
    -   Full card browser with filters for flagged or suspended cards.
    -   Smooth scroll preservation after reviews.

---

## 🚀 Core Workflow

### 1. Write or Import Notes

Treat each note as a “chapter” within a subject (folder). Write normally in Markdown, including images.

### 2. Finalize the Chapter

Prepare the note for gating by converting paragraphs into trackable units. The process is idempotent, meaning you can finalize and un-finalize without losing your manual splits.

-   **Auto Finalize:**
    -   `Gated Notes: Finalize note (auto-paragraphs)` — Splits on double newlines. If manual split markers are detected, you'll be prompted to choose which method to use.
-   **Manual Finalize:**
    -   Insert split markers (`Mod+Shift+Enter`) where you want breaks, then run `Gated Notes: Finalize note (manual splits)`.
    -   Use `Gated Notes: Remove all paragraph breakpoints` to clean up a note.

### 3. Generate or Add Cards

-   **AI Generation:**
    -   `Gated Notes: Generate flashcards from finalized note` — The AI will read the entire note, including image analyses, to create cards.
    -   A new modal allows you to provide **custom guidance** to steer the AI's output.
    -   If cards already exist, you'll be prompted to generate *additional* cards, with options to prevent duplicates and add guidance.
-   **Manual Creation:**
    -   Highlight text → right-click → “Add flashcard (manual)” or use one of the "Generate with AI" options for targeted creation.

### 4. Study to Unlock Content

-   Open a gated note — only the first section is visible.
-   Start a review in **Chapter Mode**.
-   As you answer correctly, the next section automatically unblurs and the view scrolls to it. When you fail a card, you can instantly jump to the source text or image to review.

---

## 🛠 Installation & Setup

1.  **Install via BRAT** (recommended for the latest version):
    -   Install BRAT from Community Plugins.
    -   Add this repo’s GitHub path (`shaynweidner/obsidian-gated-notes`) in BRAT’s settings.
2.  **Configure AI Provider**:
    -   Choose **OpenAI** or **LM Studio** in plugin settings.
    -   Enter your API key (OpenAI) or local server URL (LM Studio).
    -   Click **Fetch Models** to load the available text models.
3.  **(OpenAI) Configure Multimodal Model**:
    -   For image analysis, select a multimodal model like `gpt-4o` or `gpt-4o-mini` in the "OpenAI Multimodal Model" dropdown.
4.  **Optional Settings**:
    -   Adjust learning steps, bury delay, and other spaced repetition parameters.
    -   Toggle content gating on or off globally from the settings or the status bar.

---

## ⚙️ Key Commands

| Command | Description |
| :--- | :--- |
| `Review due cards` | Starts a review session for the current mode. |
| `Toggle content gating` | Enable/disable blur without changing settings. |
| `Browse cards` | Open the stateful Card Browser with filtering options. |
| `Finalize note (auto/manual)` | Prepare note for gating. |
| `Un-finalize chapter` | Revert to plain Markdown, adding split markers between former paragraphs. |
| `Remove all paragraph breakpoints` | Deletes all manual split markers from the current note. |
| `Reset flashcard review history...` | Resets all cards in the chapter to "new," preserving the cards themselves. |
| `Recalculate paragraph indexes...` | Re-sync all cards with their source text after edits. |
| `Delete all flashcards for this chapter` | Remove all cards tied to the active note. |
| `Remove image analysis for this note` | Deletes the cached AI analysis for all images within the current note. |
| `Remove all image analysis data` | Deletes all cached AI image analysis data across the entire vault. |

---

## ❤️ Contributing

Contributions, bug reports, and feature requests are welcome!
Open an issue or PR on [GitHub](https://github.com/shaynweidner/obsidian-gated-notes).
