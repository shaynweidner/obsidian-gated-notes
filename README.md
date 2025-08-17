# Gated Notes 🧠

**AI-powered, gated reading and spaced repetition for Obsidian.**

**Gated Notes** is an Obsidian plugin that transforms reading into an active learning process. Inspired by [Andy Matuschak and Michael Nielsen’s concept of the “Mnemonic Medium”](https://numinous.productions/ttft/#introducing-mnemonic-medium), it combines **gated reading** with an **SM-2 spaced repetition system** and **AI-driven flashcard generation**.

Instead of passively consuming information, you must _earn_ your way through a note: later sections remain blurred until you’ve correctly answered flashcards tied to earlier sections.

---

## ✨ Key Features

-   **Gated Reading:** Locks later paragraphs in a note until you’ve mastered the flashcards for the current section.

-   **🖼️ Multimodal AI:**
    -   **Image Analysis:** Automatically analyzes images in your notes, understanding diagrams, charts, photos, and more.
    -   **Contextual Card Generation:** Creates flashcards that specifically ask about the content and purpose of your images.
    -   **Intelligent Tagging:** Links image-based cards directly to the source image for quick context-jumping during reviews.

-   **AI-Powered Flashcards:** Create cards automatically using OpenAI (including GPT-4o) or a local LM Studio instance.

-   **Advanced AI Tools:**
    -   **Split Card:** Break a complex card into smaller, more atomic ones.
    -   **Refocus Card:** Generate alternate phrasings or questions for the same fact.
    -   **Auto-Correct Tags:** If the AI generates a tag that isn't a direct quote, it will automatically attempt to fix it.

-   **SM-2 Scheduling:** Built-in spaced repetition ensures maximum retention.

-   **Multiple Study Modes:**
    -   **🎯 Chapter Mode:** Review cards for the current chapter in gated reading.
    -   **📚 Subject Mode:** Review all cards in a subject folder.
    -   **🧠 Review Mode:** Study all due cards vault-wide.

-   **Rich UI Enhancements:**
    -   Status bar due-card counter.
    -   File explorer icons showing chapter status (`⏳` blocked, `📆` due, `✅` done).
    -   Full card browser with filters and inline editing.

---

## 🚀 Core Workflow

### 1. Write or Import Notes

Treat each note as a “chapter” within a subject (folder). Write normally in Markdown, including images.

### 2. Finalize the Chapter

Prepare the note for gating by converting paragraphs into trackable units. The process is now idempotent, meaning you can finalize and un-finalize without losing your manual splits.

-   **Auto Finalize:**
    -   `Gated Notes: Finalize note (auto-paragraphs)` — Splits on double newlines. If manual split markers are detected, you'll be prompted to choose which method to use.
-   **Manual Finalize:**
    -   Insert split markers (`Mod+Shift+Enter`) where you want breaks, then run
    -   `Gated Notes: Finalize note (manual splits)`.

### 3. Generate or Add Cards

-   **AI Generation:**
    -   `Gated Notes: Generate flashcards from finalized note` — The AI will read the entire note, including image analyses, to create cards.
    -   If cards already exist, you'll be prompted to generate *additional* cards, with an option to prevent duplicates.
-   **Manual Creation:**
    -   Highlight text → right-click → “Add flashcard (manual)” or use one of the "Generate with AI" options for targeted creation.

### 4. Study to Unlock Content

-   Open a gated note — only the first section is visible.
-   Start a review in **Chapter Mode**.
-   As you answer correctly, the next section automatically unblurs. When you fail a card, you can instantly jump to the source text or image to review.

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

| Command                               | Description                                                      |
| ------------------------------------- | ---------------------------------------------------------------- |
| `Review due cards`                    | Starts a review session for the current mode.                    |
| `Toggle content gating`               | Enable/disable blur without changing settings.                   |
| `Browse cards`                        | Open the Card Browser.                                           |
| `Finalize note (auto/manual)`         | Prepare note for gating.                                         |
| `Un-finalize chapter`                 | Revert to plain Markdown, preserving manual split markers.       |
| `Recalculate paragraph indexes`       | Re-sync all cards with their source text after edits.            |
| `Delete all flashcards for this chapter` | Remove all cards tied to the active note.                      |

---

## ❤️ Contributing

Contributions, bug reports, and feature requests are welcome!
Open an issue or PR on [GitHub](https://github.com/shaynweidner/obsidian-gated-notes).
