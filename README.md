# Gated Notes 🧠

**AI-powered, gated reading and spaced repetition for Obsidian.**

**Gated Notes** is an Obsidian plugin that transforms reading into an active learning process. Inspired by [Andy Matuschak and Michael Nielsen's concept of the "Mnemonic Medium"](https://numinous.productions/ttft/#introducing-mnemonic-medium), it combines **gated reading** with **scientifically-grounded spaced repetition** (SM-2 or Bayesian Ebisu) and **AI-driven flashcard generation**.

Instead of passively consuming information, you must _earn_ your way through a note: later sections remain blurred until you’ve correctly answered flashcards tied to earlier sections.

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
    -   **🎯 Ebisu Bayesian Scheduling:** Choose between traditional SM-2 or modern Bayesian scheduling:
        -   **Beta Distribution Modeling:** Uses statistical inference to model recall probability over time
        -   **Configurable Parameters:** Set half-life, confidence priors, and rating-specific update rules
        -   **History Replay Mode:** Optional recalculation from review history for parameter experimentation
        -   **Lightweight & Interpretable:** No heavy ML frameworks, just proven Bayesian statistics
    -   **📊 Split Card History Inheritance:** Split cards preserve parent's review history and scheduling state
    -   **🎯 Advanced Mnemonic System:** Comprehensive memory aid system with AI-powered generation:
        -   **Automatic Number Detection:** Detects numbers in your cards and generates memorable phonetic word associations using the Major System
        -   **10 AI Generation Styles:** Choose from Alliterative, Rhyming, Humorous, Visual/Concrete, Story-based, Sounds-Alike/Phonetic, Acronym/Acrostic, Peg/Body Method, Memory Palace/Spatial, or Default approaches
        -   **Customizable Peg Systems:** Create and manage multiple peg systems (e.g., Rhyming 1-10, Body Parts) with custom number-to-word mappings
        -   **Customizable Memory Palaces:** Design multiple memory palaces with sequential locations for spatial mnemonic techniques
        -   **CRUD Management:** Full create, read, update, delete functionality for both peg systems and memory palaces
        -   **Drag-to-Reorder:** Organize pegs and palace locations with intuitive drag-and-drop reordering
        -   **Multi-Generation Mode:** Generate 3 alternative mnemonics at once for comparison and selection
        -   **Card Type Override:** Manual control over content analysis - specify List, Quote/verse, Foreign words, Concept, or Number-focused generation
        -   **Iterative Content Development:** Generate multiple mnemonics with automatic numbering (Mnemonic 1, Mnemonic 2, etc.)
        -   **Context-Aware Generation:** AI receives existing mnemonic content to create complementary alternatives
    -   **🎨 Card Appearance Randomization:** Optional visual randomization for desirable difficulty:
        -   **Font Size:** Randomize between min/max pixel values
        -   **Font Family:** Randomize from a customizable list of fonts
        -   **Text Color:** Randomize from a customizable color palette
        -   **Text Alignment:** Randomize between left, center, or right
        -   **Text Transform:** Randomize capitalization (none, capitalize, uppercase, lowercase)
        -   **Background Color:** Randomize card background from a customizable palette
        -   **Rotation:** Apply subtle rotation between min/max degrees
        -   **Blur:** Add slight blur effect for increased difficulty
        -   **Line Height:** Randomize line spacing for varied visual density
        -   **Letter Spacing:** Randomize character spacing
        -   **Granular Control:** Enable/disable and configure each randomization option independently
    -   **🔀 Smart Interleaving:** In Custom Session and Review-only modes, cards are selected using a weighted random algorithm that prioritizes more overdue cards, making study sessions more effective.
    -   **⏭️ Session Continuation:** Smart session management that prompts users to review additional cards that become due during study sessions, with skip tracking to avoid re-prompting skipped cards.
    -   **Review Ahead:** Finished your queue? A new modal prompts you to study cards due in the near future.
    -   **Buried Cards:** A new `buried` state for cards that are temporarily hidden after being answered, preventing them from reappearing in the same session.
    -   **⚙️ Note Focus Control:** New setting to prioritize review cards before new cards in Note Focus mode.

-   **🖼️ Multimodal AI & File Explorer:**
    -   **Contextual Image Analysis:** Automatically analyzes images, using surrounding text to understand diagrams, charts, and photos. It extracts key facts and context, not just visual elements.
    -   **Smarter Card Generation:** Creates flashcards that test factual knowledge *from* diagrams (`key_facts`) or ask visual questions that require seeing the image.
    -   **Intelligent Tagging:** Links image-based cards directly to the source image for quick context-jumping.
    -   **File Explorer Decorator:** See the status of your notes at a glance with new icons (⏳, 📆, ✅) directly in the file explorer.

-   **📖 Polyglot Vocabulary System:** Specialized flashcard mode for language learners:
    -   **Cluster-Based Organization:** Group related vocabulary with headings (`## Cluster: Topic Name`)
    -   **Flexible Formats:** Support for `word|translation`, `phrase :: meaning`, and `term - definition` formats
    -   **Frontmatter Configuration:** Control native/target language, card direction (forward/reverse/bidirectional)
    -   **Automatic Card Generation:** Parse notes and generate flashcards automatically from cluster content
    -   **No Paragraph Indexing:** Polyglot cards bypass standard gating requirements for streamlined vocabulary study

-   **📝 Verbatim Flashcard System:** Memorize text word-for-word with intelligent splitting:
    -   **Multiple Split Modes:** Word-by-word, line-by-line, sentence-by-sentence, or custom delimiter
    -   **Stanza Preservation:** Line mode intelligently preserves empty lines (stanza breaks) in context
    -   **Progressive Display:** Each card shows all prior text as context for the current unit
    -   **Named Collections:** Optionally name your verbatim collection for organization
    -   **No Gating Impact:** Verbatim cards never block content gating
    -   **Context Menu Access:** Right-click selected text → "Create verbatim flashcards"

-   **🤖 Advanced AI Tools:**
    -   **Post-Generation Review:** After generating new cards, you're prompted to immediately review, edit, or delete them in a streamlined workflow.
    -   **Guidance Repository System:** Save, manage, and reuse custom AI instructions across all generation tasks:
        -   **6 Built-in Snippets:** Essential, Expanded, and Comprehensive card generation presets (plus "Additional" variants for complementing existing cards)
        -   **Save & Load:** Store frequently-used instructions and recall them with one click via the Repository button
        -   **Drag-to-Reorder:** Organize your guidance snippets in your preferred order
        -   **Priority System:** Custom guidance takes highest priority, overriding conflicting default instructions
    -   **Custom Guidance (for Cards):** Direct the AI during card generation with specific instructions.
    -   **Bulk Operations:** Process entire notes at once for efficient card management:
        -   **Bulk Refocus:** Invert front/back information for all cards in a note to create complementary questions
        -   **Bulk Variants:** Create alternate phrasings for all cards in an entire note in one operation
    -   **Split Card:** Break a complex card into smaller, more atomic ones.
    -   **Refocus Card:** Generate alternate phrasings or "reverse" questions for the same fact.
    -   **Generate Variants:** Create multiple alternative phrasings of existing cards ("Just One" or "One or More") with cost confirmation.
    -   **Auto-Correct Tags:** If the AI generates a tag that isn't a direct quote, it will automatically attempt to fix it.

-   **🗂️ Powerful Card Management:**
    -   **Advanced Card Browser:** Complete search and filtering system:
        -   **Full-Text Search:** Search across card fronts, backs, and tags simultaneously
        -   **Exact String Search:** Wrap any search term in quotes for precise matching
        -   **Three-State Filtering:** Off/Include-Only/Exclude states for flagged, suspended, buried, and new cards
        -   **Modal Navigation History:** Navigate seamlessly between views without losing your place
        -   **Scroll Position Memory:** Automatically saves and restores your scroll position when switching between notes
    -   **Intelligent Duplicate Detection:** Find and remove duplicate flashcards with advanced similarity analysis:
        -   **Jaccard Similarity Algorithm:** Uses lemmatization and set-based comparison for accurate duplicate detection
        -   **Multiple Comparison Modes:** Compare fronts only, backs only, front OR back, front AND back, or front+back combined
        -   **Flexible Scope:** Scan current note only, entire vault, current folder, or by card type (regular/polyglot/verbatim)
        -   **Review & Delete Workflow:** Examine duplicate groups with similarity scores before selective deletion
    -   **Related Cards Discovery:** "Related: X" buttons in edit modals and review sessions instantly find cards sharing the same tags.
    -   **Flag & Suspend Cards:** Mark cards with a 🚩 for future attention or suspend them (⏸️) to temporarily remove them from reviews.
    -   **Card Variants:** Edit cards with multiple variant phrasings in a dropdown interface.
    -   **Reset Card Progress:** Reset individual cards back to "new" from the edit modal.

-   **🗓️ SM-2 Scheduling:** Built-in spaced repetition ensures maximum retention.

-   **Multiple Study Modes:**
    -   **🎯 Note Mode:** Review cards for the current note in gated reading - supports any folder structure including deeply nested folders (no longer requires flat ./subject/chapter.md organization).
    -   **🎯 Custom Session Mode:** Launch targeted study sessions directly from Card Browser - select specific notes, folders, or search results to create focused review sessions with flexible vault organization.
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
