# Gated Notes 🧠

**AI-powered, gated reading and spaced repetition for Obsidian.**

**Gated Notes** is an Obsidian plugin that transforms reading into an active learning process. Inspired by [Andy Matuschak and Michael Nielsen’s concept of the “Mnemonic Medium”](https://numinous.productions/ttft/#introducing-mnemonic-medium), it combines **gated reading** with an **SM-2 spaced repetition system** and **AI-driven flashcard generation**.

Instead of passively consuming information, you must _earn_ your way through a note: later sections remain blurred until you’ve correctly answered flashcards tied to earlier sections.

---

## ✨ What's New: The Card Browser & Study Mode Revolution!

This release fundamentally transforms the Card Browser with a complete search system and introduces a revolutionary study mode architecture. The old rigid folder structure has been replaced with flexible nested folder support and a powerful custom session system launched directly from the Card Browser.

-   **🔍 Complete Card Browser Search & Related Cards:** Brand-new search system with full-text search, advanced tag search (`tag:"exact-tag"`), MathJax rendering, and "Related: X" buttons that instantly find cards sharing the same tags. Performance-optimized with smart result limiting.
-   **🎯 Study Mode Revolution:** Complete overhaul of study modes with nested folder support:
    -   **Note Mode** (replaces Chapter Mode): Now supports nested folder structures instead of requiring flat ./subject/chapter.md organization
    -   **Custom Session Mode** (replaces Subject Mode): Launch targeted study sessions directly from Card Browser selections - choose specific notes, folders, or search results
    -   **Flexible Vault Organization:** No longer constrained to subject/chapter structure - organize your vault however you want
-   **🎛️ Enhanced Three-State Filtering:** Upgraded filter system with off/include-only/exclude states for flagged, suspended, buried, and new cards. All filter states are now persistent across sessions.
-   **🧭 Modal Navigation System:** The Card Browser and Edit Modals now have a navigation history, allowing you to go back and forth between views without losing your place.
-   **📊 Study Statistics & Badge Fixes:** Fixed critical issues with badge logic that wasn't properly respecting suspended card status throughout the application.
-   **🧠 Complete Major System Implementation:** Full mnemonic generation system with corrected phonetic mappings (NG→N+G sounds, ER→R sounds), fallback dictionary, CMU dictionary integration, and persistent mnemonic storage within flashcards.
-   **⏭️ Session Continuation:** Smart session management that prompts users to review additional cards that become due during study sessions, with skip tracking to avoid re-prompting skipped cards.

---

## ✨ Key Features

-   **Gated Reading:** Locks later paragraphs in a note until you’ve mastered the flashcards for the current section. When you unlock new content, the plugin **automatically scrolls to the next contentful paragraph and highlights it**.

-   **📚 Advanced PDF & EPUB Conversion:**
    -   **📄 Interactive PDF Editor:** A brand new post-conversion workflow for perfect notes, featuring a live markdown editor, side-by-side image management (placement, rotation, stitching), and a tool to capture missing images directly from the PDF.
    -   **⚡ 2-Phase PDF Processing:** An evolution of the "Nuclear Option" that uses a two-phase approach (per-page multimodal analysis followed by a final reconciliation pass) for unparalleled accuracy.
    -   **✂️ Universal Snipping Tool:** Capture images from anywhere: from your clipboard, a file, or snip a region directly from a PDF to add to your notes.
    -   **🧹 Unused Image Cleaner:** A new command to scan your vault and find/delete unreferenced images to save space.
    -   **EPUB Import:** Convert EPUB files directly into Obsidian notes, selecting specific chapters or sections from the table of contents to include.
    -   **Structural & Custom Guidance:** Provide an example note to guide the AI's formatting or direct it with specific instructions (e.g., "Summarize key points," "Focus only on definitions").

-   **💰 LLM Cost Estimation & Logging:**
    -   See an **estimated cost** for any AI action *before* you run it, with support for complex scenarios like multi-pass hybrid PDF processing.
    -   The plugin keeps a log of all AI API calls, allowing you to track your token usage and spending over time.

-   **🧠 Smarter Review & Learning Engine:**
    -   ** mnemonic System (Major System):** Automatically detect numbers in your cards and generate memorable phonetic word associations to aid in memorization.
    -   **🔀 Smart Interleaving:** In Custom Session and Review-only modes, cards are selected using a weighted random algorithm that prioritizes more overdue cards, making study sessions more effective.
    -   **Review Ahead:** Finished your queue? A new modal prompts you to study cards due in the near future.
    -   **Buried Cards:** A new `buried` state for cards that are temporarily hidden after being answered, preventing them from reappearing in the same session.
    -   **⚙️ Note Focus Control:** New setting to prioritize review cards before new cards in Note Focus mode.
    -   **🐛 Gating Logic Fix:** Buried cards are now correctly excluded from the gating logic, ensuring smoother content unlocking.

-   **🖼️ Multimodal AI & File Explorer:**
    -   **Contextual Image Analysis:** Automatically analyzes images, using surrounding text to understand diagrams, charts, and photos. It extracts key facts and context, not just visual elements.
    -   **Smarter Card Generation:** Creates flashcards that test factual knowledge *from* diagrams (`key_facts`) or ask visual questions that require seeing the image.
    -   **Intelligent Tagging:** Links image-based cards directly to the source image for quick context-jumping.
    -   **File Explorer Decorator:** See the status of your notes at a glance with new icons (⏳, 📆, ✅) directly in the file explorer.

-   **🤖 Advanced AI Tools:**
    -   **Post-Generation Review:** After generating new cards, you're prompted to immediately review, edit, or delete them in a streamlined workflow.
    -   **Custom Guidance (for Cards):** Direct the AI during card generation with specific instructions.
    -   **Split Card:** Break a complex card into smaller, more atomic ones.
    -   **Refocus Card:** Generate alternate phrasings or "reverse" questions for the same fact.
    -   **Generate Variants:** Create multiple alternative phrasings of existing cards ("Just One" or "One or More") with cost confirmation.
    -   **Auto-Correct Tags:** If the AI generates a tag that isn't a direct quote, it will automatically attempt to fix it.

-   **🗂️ Powerful Card Management:**
    -   **Advanced Card Browser:** Complete search system with full-text and tag search, three-state filtering (off/include-only/exclude), MathJax rendering, and persistent state. Navigate seamlessly with modal navigation history.
    -   **Related Cards Discovery:** "Related: X" buttons in edit modals and review sessions instantly find and display cards sharing the same tags, with performance-optimized search within the same deck.
    -   **Custom Study Sessions:** Launch targeted study sessions directly from Card Browser - select specific notes, folders, or search results to create focused review sessions.
    -   **Smart Search & Filtering:** Search across card content with `tag:"exact-tag"` syntax, performance-optimized with result limiting and proper debouncing to prevent UI freezing.
    -   **Flag & Suspend Cards:** Mark cards with a 🚩 for future attention or suspend them (⏸️) to temporarily remove them from reviews.
    -   **Card Variants:** Edit cards with multiple variant phrasings in a dropdown interface.
    -   **Reset Card Progress:** Reset individual cards back to "new" from the edit modal.

-   **🗓️ SM-2 Scheduling:** Built-in spaced repetition ensures maximum retention.

-   **Multiple Study Modes:**
    -   **🎯 Note Mode:** Review cards for the current note in gated reading (supports nested folder structures).
    -   **🎯 Custom Session Mode:** Launch targeted study sessions directly from Card Browser selections - choose specific notes, folders, or search results to create focused review sessions.
    -   **🧠 Review Mode:** Study all due cards vault-wide.

---

## 🚀 Core Workflow

### 1. Write or Import Notes

-   **Write:** Treat each note as a “chapter.” Write normally in Markdown.
-   **Import:** Use the `Convert PDF to Note` or `Convert EPUB to Note` commands to have an AI generate a structured note from an external file.

### 2. Finalize the Note

Prepare the note for gating by converting paragraphs into trackable units. The process uses a markdown-friendly `---GATED-NOTES-SPLIT---` marker.

-   **Auto Finalize:**
    -   `Gated Notes: Finalize note (auto-paragraphs)` — Splits on double newlines. If manual split markers are detected, you'll be prompted to choose which method to use.
-   **Manual Finalize:**
    -   Insert split markers (`Mod+Shift+Enter`) where you want breaks, then run `Gated Notes: Finalize note (manual splits)`.
    -   Use `Gated Notes: Remove all manual split tags...` to clean up a note.

### 3. Generate or Add Cards

-   **AI Generation:**
    -   `Gated Notes: Generate flashcards from finalized note` — The AI will read the entire note to create cards.
    -   After generation, you'll be prompted to **review the new cards** one by one to ensure quality.
-   **Manual Creation:**
    -   Highlight text → right-click → “Add flashcard (manual)” or use one of the "Generate with AI" options for targeted creation.

### 4. Study to Unlock Content

-   Open a gated note — only the first section is visible.
-   Start a review in **Note Mode**.
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
| `Study overview` | Open a modal with vault-wide flashcard statistics. |
| `Finalize note (auto/manual)` | Prepare note for gating using `---GATED-NOTES-SPLIT---`. |
| `Un-finalize chapter` | Revert to plain Markdown, adding split markers between former paragraphs. |
| `Convert PDF to Note (Experimental)` | Uses AI to convert a PDF file into a structured markdown note. |
| `Convert EPUB to Note (Experimental)`| Extracts selected sections from an EPUB into a markdown note. |
| `Remove all manual split tags...` | Deletes all `---GATED-NOTES-SPLIT---` markers from the current note. |
| `Reset flashcard review history...` | Resets all cards in the chapter to "new," preserving the cards themselves. |
| `Recalculate paragraph indexes...` | Re-sync all cards with their source text after edits. |
| `Delete all flashcards for this chapter` | Remove all cards tied to the active note. |
| `Remove image analysis for this note` | Deletes the cached AI analysis for all images within the current note. |
| `Remove all image analysis data` | Deletes all cached AI image analysis data across the entire vault. |
| `Remove unused images from vault` | Scans your vault for unreferenced images and prompts you to delete them. |

---

## ❤️ Contributing

Contributions, bug reports, and feature requests are welcome!
Open an issue or PR on [GitHub](https://github.com/shaynweidner/obsidian-gated-notes).
