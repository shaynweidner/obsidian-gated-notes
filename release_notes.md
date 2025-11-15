# v2.10.0

## 🎯 Ebisu Bayesian Scheduling & Split Card Inheritance 🎯

This release replaces complex neural network scheduling with a lightweight, interpretable Bayesian algorithm (Ebisu), simplifies the scheduling options to SM-2 and Ebisu only, and adds intelligent review history inheritance for split cards to preserve learning progress.

### 🚀 New Features

-   **🎯 Ebisu Bayesian Scheduling Algorithm:** A new, scientifically-grounded scheduling algorithm based on Bayesian inference:
    -   **Beta Distribution Modeling:** Uses Beta distributions to model recall probability over time with statistical rigor
    -   **Configurable Prior Parameters:** Set default half-life (hours), alpha/beta confidence parameters for new cards
    -   **Rating-Specific Updates:** Customize success/total parameters for each rating (Again: 0/1, Hard: 1/2, Good: 1/1, Easy: 2/2)
    -   **Target Recall Setting:** Configure target recall probability (default 85%) for interval calculations
    -   **History Replay Mode:** Optional "always recalculate from history" setting for parameter tuning experiments
    -   **Comprehensive Logging:** Console logs show model updates, recall probabilities, and interval calculations
    -   **Lightweight Implementation:** Uses pre-bundled ebisu-js library (no heavy ML frameworks)
-   **📊 Split Card Review History Inheritance:** Split cards now preserve learning progress:
    -   **Automatic Inheritance (Default):** Split cards inherit parent's review_history, status, intervals, and algorithm data
    -   **Algorithm Preservation:** Copies SM-2 ease factors or Ebisu model (alpha, beta, time) from parent
    -   **Toggleable Setting:** Can be disabled if you prefer split cards to start fresh
    -   **Seamless Integration:** Works transparently with both SM-2 and Ebisu algorithms
-   **⚡ Simplified Algorithm Options:** Streamlined scheduling to two proven approaches:
    -   **SM-2 (Traditional):** Classic SuperMemo 2 algorithm with ease factors
    -   **Ebisu (Bayesian):** Modern Bayesian approach with statistical modeling
    -   **Settings UI Update:** Clean dropdown with only two choices for easier decision-making

### ⚠️ Breaking Changes

-   **🔴 REMOVED: FSRS Algorithm:** The FSRS scheduling algorithm has been removed to simplify the codebase
    -   Existing FSRS cards will need to be reset or manually migrated to SM-2 or Ebisu
    -   FSRS settings and UI panels have been removed
-   **🔴 REMOVED: GRU/TensorFlow Neural Network Model:** The experimental GRU recall model has been removed
    -   Removed dependencies: @tensorflow/tfjs (saves ~50MB)
    -   Removed files: train_gru.ts, recall_infer.ts, export_weights.ts
    -   Simplified codebase with no runtime TensorFlow overhead

### 🎨 Improvements

-   **📝 Code Cleanup:** Removed 300+ lines of unused scheduling code
-   **📚 Better Documentation:** Added docstrings to all scheduling methods
-   **🔧 Cleaner Settings:** Removed complex FSRS parameter configuration UI
-   **⚡ Faster Builds:** Reduced bundle size by removing TensorFlow dependencies

---

# v2.9.0

## ✨ Comprehensive Mnemonic System, New Flashcard Types & Advanced Card Management ✨

This release represents a major expansion of the plugin's capabilities with user-customizable peg systems and memory palaces for advanced mnemonic techniques, two new specialized flashcard types (Polyglot for language learning and Verbatim for word-for-word memorization), intelligent duplicate detection for card management, comprehensive card appearance randomization for desirable difficulty, and powerful AI workflow improvements including a guidance repository system and hierarchical API provider configuration.

### 🚀 New Features

-   **📁 Guidance Repository System:** Save, manage, and reuse custom AI instructions across all generation tasks:
    -   **Persistent Snippet Library:** Store frequently-used AI instructions and recall them with one click
    -   **6 Built-in Presets:** Essential, Expanded, and Comprehensive card generation snippets, plus "Additional" variants for complementing existing cards
    -   **Repository Modal:** Browse, use, edit, and delete saved guidance snippets in one unified interface
    -   **Drag-to-Reorder:** Organize your guidance library in your preferred order with intuitive drag-and-drop
    -   **Priority System:** Custom guidance now takes highest priority, with clear formatting that overrides conflicting default instructions
    -   **Universal Integration:** Repository button appears in all modals with custom guidance support (card generation, variants, refocus, PDF/EPUB conversion)

### 🎯 Customizable Peg Systems & Memory Palaces

-   **User-Customizable Mnemonic Techniques:** Full CRUD management for peg systems and memory palaces:
    -   **Peg System Management:**
        -   **Create Custom Peg Systems:** Define your own number-to-word mappings for any mnemonic system
        -   **Two Default Systems:** Ships with "Rhyming 1-10" (bun, shoe, tree...) and "Body Parts 1-10" (head, shoulders, chest...)
        -   **CRUD Operations:** Add, edit, rename, and delete peg systems through dedicated management modal
        -   **Drag-to-Reorder Pegs:** Organize peg mappings in your preferred sequence
        -   **Style Selection:** Choose "Peg/Body Method" style in mnemonic modal to use selected peg system
    -   **Memory Palace Management:**
        -   **Create Custom Palaces:** Design memory palaces with sequential locations for spatial mnemonics
        -   **Default Palace:** Ships with "Generic House" (Front door, Hallway, Living room, Kitchen, Bedroom)
        -   **CRUD Operations:** Full management interface for creating, editing, renaming, and deleting palaces
        -   **Drag-to-Reorder Locations:** Arrange palace locations to match your mental journey
        -   **Style Selection:** Choose "Memory Palace/Spatial" style to use selected palace
    -   **Enhanced Mnemonic Styles:**
        -   **10 Total Styles:** Added 4 new styles to existing 6 (Alliterative, Rhyming, Humorous, Visual, Story, Default):
            -   **Sounds-Alike/Phonetic:** Phonetic anchors for foreign words (e.g., "Astyanax" → "ask-tea-in-axe")
            -   **Acronym/Acrostic:** Extract key words and create memorable acronyms (like HOMES for Great Lakes)
            -   **Peg/Body Method:** Attach items to numbered pegs using user-defined systems
            -   **Memory Palace/Spatial:** Place items in specific locations within user-defined palaces
    -   **Multi-Generation Mode:** Checkbox to generate 3 alternative mnemonics at once instead of 1
    -   **Improved Mnemonic Numbering:** Automatic sequential numbering (Mnemonic 1, 2, 3...) with intelligent counter
    -   **Structured Output Formats:** Each strategy has tailored output format (e.g., Acronym shows "Key words → Acronym → Explanation")
    -   **Settings Commands:**
        -   **Manage peg systems:** Opens peg system management modal
        -   **Manage memory palaces:** Opens memory palace management modal

### 🎨 Card Appearance Randomization

-   **Desirable Difficulty Through Visual Variation:** Optional randomization of card appearance during review sessions:
    -   **Ten Randomization Categories:**
        -   **Font Size:** Vary text size between customizable min/max pixel values (default: 14-20px)
        -   **Font Family:** Rotate through a customizable list of fonts (default: Arial, Helvetica, Georgia, Verdana)
        -   **Text Color:** Apply random colors from a customizable palette (default: black, dark gray, medium gray, blue)
        -   **Text Alignment:** Randomize between left, center, and right alignment
        -   **Text Transform:** Randomize capitalization (none, capitalize, uppercase, lowercase)
        -   **Background Color:** Randomize card background from palette (default: white, light gray, light yellow, light blue)
        -   **Rotation:** Apply subtle rotation between min/max degrees (default: -3 to +3 degrees)
        -   **Blur:** Add slight blur effect for increased difficulty (default: 0-1px)
        -   **Line Height:** Adjust vertical spacing between lines (default: 1.4-1.8)
        -   **Letter Spacing:** Modify horizontal spacing between characters (default: 0-1px)
    -   **Granular Control:** Each randomization type can be independently enabled/disabled with custom ranges
    -   **Master Toggle:** Global on/off switch for all randomization features
    -   **Per-Card Application:** Randomization applied fresh for each flashcard front during review
    -   **Settings UI:** Comprehensive configuration panel with collapsible sections for each randomization type
    -   **Smart Padding:** Automatic padding added when rotation is enabled to prevent overlap with UI buttons

### 📝 Verbatim Flashcard System

-   **Word-for-Word Memorization with Intelligent Splitting:** A new flashcard type for verbatim text memorization:
    -   **Four Split Modes:**
        -   **Word-by-Word:** Each card prompts for the next single word
        -   **Line-by-Line:** Each card prompts for the next complete line
        -   **Sentence-by-Sentence:** Each card prompts for the next complete sentence
        -   **Custom Delimiter:** Split by any character/string you specify
    -   **Stanza-Aware Line Splitting:** Line mode preserves poem/verse structure:
        -   Empty lines (stanza breaks) are intelligently included in context
        -   Context shows all prior lines including blank lines for proper structure
        -   Only non-empty lines count toward progression
    -   **Progressive Context Display:** Each card shows all previous text as context, with the current unit as the answer
    -   **Named Collections:** Optional collection names for organizing related verbatim sets
    -   **Gating Bypass:** Verbatim cards are marked as `bypassesGating` and never block content unlocking
    -   **Easy Creation:** Right-click any selected text → "Create verbatim flashcards" → Choose split mode
    -   **Separate Storage:** Verbatim cards stored with `type: 'verbatim'` for filtering and management

### 📖 Polyglot Vocabulary System

-   **New Specialized Mode for Language Learning:** A complete vocabulary flashcard system designed specifically for language learners:
    -   **Cluster-Based Organization:** Group related vocabulary using `## Cluster: Topic Name` headings
    -   **Multiple Input Formats:** Supports three formats for maximum flexibility:
        -   Pipe format: `word|translation`
        -   Double-colon format: `phrase :: meaning`
        -   Dash format: `term - definition`
    -   **Frontmatter Configuration:** Control behavior through YAML frontmatter:
        -   Set `nativeLanguage` and `targetLanguage` names
        -   Choose card direction: `forward`, `reverse`, or `bidirectional`
        -   Mark as `special: polyglot` to enable polyglot parsing
    -   **Automatic Flashcard Generation:** `Polyglot: Generate cards for this note` command parses clusters and creates cards
    -   **Separate Data Storage:** Polyglot metadata stored in `_polyglot.json` files (parallel to `_flashcards.json`)
    -   **Streamlined Workflow:** Polyglot cards bypass paragraph indexing requirements - no gating, just vocabulary study
    -   **New Commands:**
        -   `Polyglot: New vocabulary note` - Creates template note with frontmatter
        -   `Polyglot: Parse this note` - Updates metadata without generating cards
        -   `Polyglot: Generate cards for this note` - Parses and creates flashcards

### 🔍 Intelligent Duplicate Detection

-   **Advanced Duplicate Card Scanner:** Find and eliminate duplicate flashcards with sophisticated similarity analysis:
    -   **Jaccard Similarity Algorithm:** Uses lemmatization-based set comparison with proper possessive handling to detect semantically similar cards
    -   **Smart Possessive Preprocessing:** Strips possessive 's before lemmatization to prevent false negatives (e.g., "John's book" and "John book" correctly recognized as similar)
    -   **Five Comparison Modes:**
        -   **Front Only:** Compare card fronts exclusively
        -   **Back Only:** Compare card backs exclusively
        -   **Front OR Back:** Match if either front or back are similar
        -   **Front AND Back:** Match only if both front and back are similar
        -   **Front+Back Combined:** Concatenate and compare as single text
    -   **Flexible Scanning Scope:**
        -   Current note only
        -   Entire vault
        -   Current folder and subfolders
        -   Filter by card type (Regular/Polyglot/Verbatim)
    -   **Interactive Review Modal:**
        -   Groups displayed with similarity scores
        -   Side-by-side card comparison
        -   Selective deletion with checkboxes
        -   Preserves first card in each group by default
    -   **Performance Optimizations:**
        -   Pre-lemmatization of all cards for efficiency
        -   Progress indicators during scanning
        -   Detailed logging of comparisons and processing time
    -   **Verbatim Card Exclusion:** Verbatim cards automatically excluded from duplicate detection scanning
    -   **New Command:** `Find duplicate flashcards` - Launches duplicate detection workflow with configuration modal

### 💾 Scroll Position Memory

-   **Automatic Scroll Restoration:** Never lose your place when navigating between notes:
    -   **Per-Note Memory:** Tracks scroll position independently for each note
    -   **Seamless Restoration:** Automatically restores position when returning to a note
    -   **Persistent Storage:** Scroll positions saved in plugin settings across sessions
    -   **Threshold Logic:** Only saves meaningful scroll positions (>0) to avoid clutter

### ⚡ Bulk Operations

-   **Bulk Refocus Cards:** Process entire notes at once with `Bulk refocus cards for current note` command:
    -   **Inversion Processing:** Automatically inverts front/back information for all cards to create complementary questions
    -   **Confirmation Modal:** Shows card count and estimated cost before processing
    -   **Batch Efficiency:** Generates multiple refocused cards per original card in one operation
    -   **Duplicate Prevention:** Built-in logic to avoid creating cards similar to existing ones
    -   **Progress Tracking:** Real-time progress display with success/failure reporting

-   **Bulk Create Variants:** Generate variant cards for all cards in a note with `Bulk create variants for current note`:
    -   **Automatic Rephrasing:** Creates alternate phrasings for every card in one operation
    -   **Skip Logic:** Intelligently skips cards that already have variants
    -   **Confirmation Workflow:** Pre-flight modal with card count before processing
    -   **Detailed Reporting:** Shows processed count, successful variants, and skipped cards

### 📚 PDF & EPUB Conversion Improvements

-   **Enhanced EPUB Processing:** Major improvements to EPUB-to-note conversion accuracy and formatting:
    -   **CSS Style Extraction:** Automatically parses embedded CSS to correctly handle subscript/superscript styling via class attributes
    -   **Smart Formatting:** Preserves subscript (`<sub>`) and superscript (`<sup>`) elements in converted markdown
    -   **Image Deduplication:** Computes image hashes to prevent duplicate image files when the same image appears multiple times
    -   **Fragment Handling:** Properly resolves file paths with fragment identifiers (e.g., `chapter01.xhtml#section2`)
    -   **Whitespace Preservation:** Improved text joining logic that better preserves original EPUB spacing and formatting
    -   **Image Tracking:** Automatically updates `_images.json` with hash-based deduplication metadata

-   **Optimized PDF Processing:** Intelligent processing strategy based on document length:
    -   **Small Document Mode:** PDFs under 10 pages processed in a single API call for speed and coherence
    -   **Chunked Processing:** PDFs with 10+ pages automatically use chunked processing to stay within context limits
    -   **Adaptive Strategy:** System automatically selects optimal processing approach based on page count

### ⚙️ API Provider Configuration Improvements

-   **Hierarchical API Provider System:** Separate provider/model configurations for different operations:
    -   **Operation-Specific Settings:** Configure different providers and models for three operation types:
        -   Flashcard Generation (Primary settings)
        -   Refocus/Split Operations
        -   Variant Generation
    -   **"Match Primary" Option:** Refocus and Variant operations can be set to "Match Primary" to use the same provider/model as flashcard generation
    -   **Per-Operation Model Lists:** Separate model lists for OpenAI and LM Studio providers
    -   **Explicit Model Validation:** Clear error messages when no model is selected for an operation
    -   **Provider-Specific Clients:** Each operation gets its own OpenAI client instance configured with appropriate provider settings
    -   **Descriptive Notifications:** Operation notifications now show which provider/model is being used (e.g., "Generating 5 cards using OpenAI (gpt-4o)...")
    -   **Settings Migration:** Automatic migration of old `availableModels` setting to new provider-specific lists
    -   **Backward Compatibility:** Legacy methods maintained for smooth transition from older versions

### 🛠️ Bug Fixes

-   **Fixed Buried Card Gating Logic:** Introduced new `isBlockingGating()` function that correctly handles buried cards:
    -   **Proper Bury Period Handling:** Buried cards with unexpired bury periods no longer block content gating
    -   **Expired Bury Detection:** Cards whose bury period has passed correctly resume blocking behavior
    -   **Consistent Logic:** Both in-note gating and chapter statistics now use unified buried card handling

---

# v2.8.0

## ✨ Mnemonic Generation System Enhancements ✨

This release significantly expands the AI-powered mnemonic generation system with advanced customization options, improved user control, and better content management. The mnemonic modal now offers comprehensive style selection, card type override capabilities, and intelligent content formatting for iterative workflow support.

### 🚀 New Features

-   **🎨 Mnemonic Style Selection System:** Choose from 6 different AI generation styles for mental imagery and emoji generation:
    -   **Alliterative:** Focus on words that start with similar sounds for memorable connections
    -   **Rhyming:** Create rhythmic, musical patterns that stick in memory
    -   **Humorous:** Use humor and absurd situations to enhance memorability
    -   **Visual/Concrete:** Emphasize vivid visual imagery with colors, textures, and tangible objects
    -   **Story-based:** Create narrative structures with characters and plot sequences
    -   **Default:** Let the AI choose the best approach for your content

-   **🎯 Mnemonic Card Type Override System:** Take manual control over content analysis for AI mnemonic generation:
    -   **Smart Detection Bypass:** Override automatic card type detection when you know better
    -   **5 Card Types:** List, Quote/verse, Foreign words, Concept, and Number-focused generation
    -   **Targeted Instructions:** AI receives specific guidance based on your override selection
    -   **Toggle Control:** Easy checkbox to enable/disable override functionality

-   **📝 Enhanced Mnemonic Content Management:** Improved workflow for iterative mnemonic development:
    -   **Markdown Formatting:** Existing mnemonic content is wrapped in code blocks when sent to AI for better context separation
    -   **Side-by-Side Display:** Clear **ORIGINAL:** and **NEW GENERATION:** sections in mnemonic modal for easy comparison
    -   **Iterative Support:** Generate multiple mnemonics to build up comprehensive collections

### 🛠️ Bug Fixes

-   **Fixed Mnemonic Temperature Settings:** Removed hardcoded temperature values (0.7, 0.8) in mnemonic LLM calls that weren't respecting the `openaiTemperature` setting
-   **Fixed Mnemonic Save Button Visibility:** Configure mnemonics modal now always shows save button regardless of number detection
-   **Fixed Padlock Icon Display:** Gated section padlock icons no longer get hidden behind blur effects - proper CSS layering implemented
-   **Fixed Card Browser Hierarchy:** Nested folder structures now display correctly with proper parent-child relationships instead of duplicate top-level entries

### 🎨 UX Improvements

-   **Mnemonic Usage Information:** Added informational text in mnemonic modal explaining how existing content is shared with AI for context-aware generation
-   **Improved Mnemonic Notifications:** Fixed misleading "0 mnemonics saved" messages by properly accounting for both major system and freeform content
-   **Context-Aware Mnemonic Prompts:** Mnemonic AI generation now receives existing freeform content to generate complementary alternatives rather than duplicating content

# v2.7.0

## ✨ New Release: The Card Browser & Study Mode Revolution! ✨

This release fundamentally transforms both the Card Browser and the study mode architecture. The Card Browser gains a complete search system with related cards functionality, while the rigid subject/chapter folder structure is replaced with flexible nested folder support and a revolutionary custom session system launched directly from the Card Browser.

### 🚀 Major New Features

-   **🔍 Complete Card Browser Search & Related Cards System:** A brand-new search feature with intelligent card discovery:
    -   **Full-Text Search:** Search across all card fronts and backs instantly
    -   **Advanced Tag Search:** Use `tag:"exact-tag"` syntax to find cards with specific tags, including tags with nested quotes
    -   **Related Cards Discovery:** "Related: X" buttons in edit modals and review sessions instantly find cards sharing the same tags
    -   **MathJax Rendering:** LaTeX expressions now render properly in search results instead of showing raw code
    -   **Performance Optimized:** Smart result limiting (100 cards max), proper debouncing, and optimized related card search within same deck
    -   **Search Result Management:** Clear messaging shows "Found 2617 cards (showing first 100)" for large result sets

-   **🎯 Study Mode Architecture Revolution:** Complete overhaul replacing the rigid subject/chapter structure:
    -   **Nested Folder Support:** Note Mode now works with any folder structure - no longer requires flat ./subject/chapter.md organization
    -   **Custom Session Mode Replaces Subject Mode:** Launch targeted study sessions directly from Card Browser selections
    -   **Flexible Vault Organization:** Organize your vault however you want - deep nested folders, any naming convention
    -   **Card Browser Integration:** Select specific notes, folders, or search results in Card Browser and instantly start custom study sessions
    -   **Session Flexibility:** Choose to include or exclude new cards, create review-only sessions from any selection

-   **🎛️ Three-State Filter System:** Completely redesigned filtering with much more power:
    -   **Three States:** Off / Include-Only / Exclude for each filter type
    -   **Persistent Filters:** All filter preferences are remembered between sessions
    -   **Enhanced Logic:** Combine filters with AND/OR logic for precise card selection
    -   **Real-Time Counts:** See exactly how many cards match each filter state

-   **🧭 Modal Navigation System:** Navigate seamlessly between different views:
    -   **Navigation History:** Go back and forth between Card Browser and Edit Modals
    -   **Context Preservation:** Never lose your place when moving between different card management interfaces
    -   **Related Card Navigation:** Click "Related: X" buttons to explore connected cards

### ✨ Critical Fixes & Improvements

-   **📊 Study Statistics & Badge Logic Fixes:** 
    -   Fixed critical bugs where suspended card status wasn't properly respected in badge calculations
    -   Study Overview and file explorer badges now show accurate status information
    -   Removed debug logging that was cluttering the console

-   **🧠 Complete Major System Mnemonic Implementation:** Full implementation of the Major System for memory techniques:
    -   **Enhanced Phonetic Mappings:** NG sounds now map to both N and G (27) instead of just G (7), ER sounds now map to R (4)
    -   **Comprehensive Word Generation:** Complete fallback dictionary with thousands of word combinations for number-to-word conversion
    -   **CMU Dictionary Integration:** Advanced word generation using the CMU pronunciation dictionary for more accurate phonetic matching
    -   **Persistent Storage:** Mnemonics are stored within flashcard data structure for long-term retention and cross-session availability
    -   **Smart Number Detection:** Automatic detection of numbers in flashcard content for mnemonic generation opportunities

-   **⏭️ Smart Session Continuation:** 
    -   **Continuation Prompts:** When sessions end, users are asked if they want to review additional cards that became due
    -   **Skip Tracking:** Cards skipped during a session won't reappear in continuation prompts
    -   **Improved Flow:** Better session management prevents interruptions and maintains study momentum

### 🎨 Visual & UX Enhancements

-   **Card Browser Visual Improvements:**
    -   **Card Separators:** Visual divider lines between search results for better readability
    -   **Inline Icons:** Status icons (🌱, 🚩) now appear inline with card text instead of on separate lines
    -   **Clean Chapter Paths:** Source paths appear on separate lines with .md suffixes removed
    -   **Compact Layout:** Optimized spacing throughout the interface

-   **Performance & Responsiveness:**
    -   **Eliminated Search Freezing:** Fixed critical issue where typing single characters like "b" or "h" would freeze the UI
    -   **Faster Interactions:** Improved debouncing and reduced expensive operations during typing
    -   **Optimized Related Cards:** Related card searches now only scan the same deck instead of the entire vault

# v2.6.0

## ✨ New Release: The Interactive PDF & Smart Review Update! ✨

This is a massive update that revolutionizes PDF-to-note conversion with a new **Interactive Editor**, **Image Stitching**, and a powerful **2-Phase Processing** engine. The review experience is now smarter with **Weighted Interleaving**, **Card Variants**, **Smart Due Time Notifications**, **"Review Ahead"** functionality, and a host of UI/UX improvements.

### 🚀 Major New Features

-   **📄 Interactive PDF-to-Note Editor:** A brand new post-conversion workflow for perfect notes:
    -   **Live Markdown Editor:** Edit the AI-generated text in a live, resizable, dual-pane modal.
    -   **Image Placement & Management:** View all extracted images alongside your note. Click to insert placeholders, rotate images, and even capture missing images directly from a PDF viewer.
    -   **Automatic & Manual Image Stitching:** The plugin now automatically detects and stitches fragmented images. You can also manually select and stitch images together.
-   **⚡ 2-Phase PDF Processing (Nuclear Option v2):** An evolution of the high-quality conversion mode. It now uses a two-phase approach (per-page multimodal analysis followed by a final reconciliation pass) for unparalleled accuracy in structure and content.
-   **✂️ Universal Snipping Tool:** Capture images from anywhere:
    -   Capture from clipboard (e.g., from a system screenshot tool like Win+Shift+S).
    -   Import directly from a file.
    -   Manually snip regions from a PDF inside the new `PDFViewerModal`.
-   **🧹 Unused Image Cleaner:** A new command to scan your vault and find/delete unreferenced images to save space.
-   **🃏 Card Variants System:** Create multiple alternative phrasings of the same flashcard:
    -   **AI-Powered Generation:** Use "Generate Variants" with quantity selection ("Just One" or "One or More") and cost confirmation.
    -   **Backwards Compatible:** Existing cards automatically work with the new system.
    -   **Shared Progress:** All variants share the same review history and scheduling data.
    -   **Smart Selection:** Random variant selection during reviews for variety.

### 🧠 Review & Learning Engine Improvements

-   **🔀 Smart Interleaving:** In Subject and Review-only modes, cards are now selected using a weighted random algorithm that prioritizes more overdue cards, making study sessions more effective and less predictable. (Configurable in settings).
-   **⏰ Smart Due Time Notifications:** After answering cards, see exactly when they're due next with intelligent formatting:
    -   "due in 30 seconds" / "due in 2 minutes" / "due in 1 hour" / "due tomorrow"
    -   Automatically selects the most appropriate time unit for clarity.
-   **Review Ahead:** Finished your queue? A new modal prompts you to study cards due in the near future (e.g., "in the next 2 hours").
-   **Buried Cards:** A new `buried` state for cards that are temporarily hidden after being answered, preventing them from reappearing in the same session.
-   **⚙️ Chapter Focus Control:** New setting to prioritize review cards before new cards in Chapter Focus mode.
-   **🐛 Gating Logic Fix:** Buried and suspended cards are now correctly excluded from the gating logic, ensuring smoother content unlocking.

### ✨ User Experience & UI

-   **🌱 New Card Indicators:** Green leaf indicators now mark new/unseen cards in the review modal title and the card browser.
-   **🎨 Enhanced Card Browser:**
    -   New filters for "Buried" and "New" cards.
    -   UI updated to use icons for filters (🚩, ⏸️, etc.).
    -   Status icons are now displayed next to each card in the list.
-   **🖼️ Better Image Processing Notices:** When generating cards, image analysis now shows a thumbnail of the image being processed.
-   **✅ Post-Generation Review Prompt:** After creating cards via AI, you're now prompted to review them immediately.
-   **🃏 Enhanced Card Editing Interface:**
    -   **Dynamic Variant Labels:** Shows "Variant (1 only)" vs "Variant (X total)" for better clarity.
    -   **Preview Dropdown Options:** Variant selector shows preview of card content ("1: What is the capital of...").
    -   **Generate Variants Button:** AI-powered variant generation with quantity selection and cost estimation.

### 🔧 Technical Improvements

-   **Advanced PDF Text Extraction:** The text extraction engine is now column-aware and uses a more sophisticated block-based approach (`extractBlocksFromReadingOrder`) to handle complex layouts.
-   **Robust Image Extraction:** The logic for finding and extracting images from PDF operator lists is significantly more robust, detecting more image types and their coordinates.
-   **New Data Structures:** Added `StitchedImage`, `SnippingResult`, `CardVariant`, and other interfaces to support the new image and variant features. The `Flashcard` interface now includes a `buried` property and optional `variants` array.
-   **Backwards Compatibility:** Existing flashcards automatically work with the new variants system through legacy field support.
-   **Enhanced Settings:** Added `showNewCardIndicators`, `chapterFocusReviewsFirst`, and `enableInterleaving` configuration options.

---

# v2.5.0

## ✨ New Release: The PDF Power-Up Update! ✨

This release introduces a massive overhaul of the PDF-to-Note conversion workflow, adding powerful new tools for context, quality control, and image handling to achieve near-perfect conversions with minimal manual effort.

### 🚀 New Features

-   **⚡ PDF Nuclear Option:** A new, high-quality processing mode for PDF conversion. It uses a 4-pass pipeline (Minimal Context -> Validation -> Deduplication -> Final Review) to produce exceptionally clean and accurate notes, virtually eliminating common AI conversion errors. *Warning: This option is token-intensive and will have a higher API cost.*
-   **🖼️ PDF Image Extractor & Placement Assistant:** After converting a PDF, the plugin now automatically extracts all images. A new modal opens, showing the extracted images side-by-side with your generated note, allowing you to easily click and place the correct images into `![IMAGE_PLACEHOLDER]` slots.
-   **🧠 Multi-Page Context for PDF Conversion:** The hybrid PDF converter can now use previous and future pages as context when processing the current page. This dramatically improves continuity, reduces repeated headers, and correctly handles paragraphs that span across pages.

### ✨ Improvements

-   **Background Image Preloading:** When you select a PDF in the conversion modal, the plugin now starts rendering page images in the background, making the final conversion step feel much faster.
-   **More Robust Image Extraction:** The underlying logic for extracting images from PDF files has been significantly improved to capture more images reliably.
-   **Smarter Example Note Processing:** The logic for abbreviating example notes has been enhanced to better preserve the structure of lists and other complex formatting.

### 🔧 Technical Changes

-   The internal `sendToLlm` function now supports sending an array of images in a single API call to facilitate the new multi-page context feature.
-   

# v2.4.1

Fixed bug whereby review cards were not shown during Chapter Focus mode, only new cards.

# v2.4.0

### 🚀 Summary

This release introduces a major enhancement to the PDF conversion feature with a new **Hybrid Mode** and **Custom AI Guidance**, providing vastly improved accuracy and control for documents with complex layouts. The underlying AI interaction logic has also been made more robust to handle a wider range of API responses and network conditions.

### ✨ New Features

-   **Enhanced PDF to Note Conversion:**
    -   **New "Hybrid" Mode:** You can now choose to process PDFs page-by-page, sending an image of each page along with its extracted text to a vision-capable AI model (like GPT-4o). This is ideal for academic papers, textbooks, and other documents where text extraction alone fails.
    -   **New Custom AI Guidance:** You can now provide specific, free-form text instructions to the AI within the PDF conversion modal to tailor the output to your needs (e.g., "Summarize each section," "Extract all definitions").
    -   **New Post-Processing Step:** An optional AI-powered cleanup pass can now reconstruct the document, intelligently merging paragraphs that were split across pages and removing repetitive page headers/footers.
    -   **Fine-Grained Controls:** The PDF modal now includes options to specify page ranges, image rendering quality (DPI), and max image width.
-   **Advanced Cost Estimation:** The cost estimator is now more intelligent, providing accurate estimates for complex multi-page hybrid PDF conversions before you commit.

### 🔧 Improvements & Fixes

-   **Robust JSON Parsing:** The logic for parsing responses from the AI has been significantly improved with multiple fallbacks and error-correction heuristics, making card generation more reliable.
-   **Reliable API Requests:** The plugin now uses a custom adapter for OpenAI API calls that leverages Obsidian's native `requestUrl` function, which can improve reliability in some network environments.
-   **Improved AI Prompts:** The prompts used for AI-assisted card "Refocus" and "Split" actions have been refined with better examples and clearer instructions to improve the quality of the results.

# v2.3.0

This version introduces major new experimental features for content creation, a comprehensive system for managing AI costs, and significant workflow enhancements that give users more control over the AI generation process.

### ✨ New Features

-   **PDF & EPUB Conversion (Experimental):** You can now convert PDF and EPUB files directly into structured markdown notes. The plugin uses an AI to process the content, with options to provide an example note for formatting guidance and to select specific chapters from EPUB files.
-   **LLM Cost Estimation & Logging:** To provide transparency and control over API usage, the plugin now shows an estimated cost for every AI action *before* you confirm it. A new log file (`_llm_log.json`) is created in your vault root to track all API calls, models used, token counts, and associated costs.

### 🤖 AI & Workflow Enhancements

-   **Post-Generation Review:** After the AI generates new cards, you are now prompted to review them in a sequential editing modal. This allows you to quickly edit, approve, or delete each card to ensure high quality before they enter your study queue.
-   **More Powerful AI Tools:** The "Refocus" and "Split Card" AI actions are now more powerful, with new options to prevent the creation of duplicate cards. The entire flow now uses a confirmation step that displays the estimated cost.
-   **New Markdown Split Marker:** The old HTML-based split marker has been replaced with a cleaner, more robust `---GATED-NOTES-SPLIT---` marker, improving the finalization and editing process.

### 🔧 Technical Improvements & Fixes

-   **Upgraded API Integration:** The plugin now uses the official OpenAI SDK for all API communication, leading to improved reliability, better error handling, and more accurate token usage data.
-   **Smarter Highlighting & Scrolling:** The "jump to context" feature is more reliable and provides clearer visual feedback with distinct highlight colors. When content is unlocked, the plugin now intelligently scrolls past empty paragraphs to the next piece of actual content.
-   **Improved Robustness:** JSON parsing from the AI is now more resilient, successfully handling a wider range of formatting quirks from different models.

# v2.2.0

## Gated Notes: Smarter Reviews & A Better Browser!

This update focuses on making the Gated Notes experience smoother, smarter, and more intuitive. We've overhauled the core review logic for greater reliability and supercharged the Card Browser to remember your every move!

### ✨ New Features

* **Persistent Card Browser:** The Card Browser now remembers its state between uses! Your scroll position, expanded folders, and selected chapter will be exactly as you left them, making card management faster and more intuitive.
* **Reset Individual Card Progress:** Made a mistake or want to re-learn a specific concept? There's a new "Reset Progress" button in the card edit modal to reset a single card back to "new" without affecting the rest of the chapter.

### 🚀 Improvements & Fixes

* **More Reliable Content Unlocking:** The logic for unlocking new paragraphs during a review is now more robust and directly tied to card data, eliminating previous inconsistencies.
* **No More Annoying Scrolling:** The view will no longer jump to the top of the note after a review session. Your scroll position is now preserved for a smoother learning flow.
* **Enhanced Card Browser Performance:** The Card Browser has been optimized for better performance and a more stable experience.

# v2.1.0

## Gated Notes 2.1.0: Smarter AI, Better Reviews, and More Control

This release is a major step forward, focusing on giving you more control over your cards and making the AI and review process significantly smarter and smoother.

### ✨ New Features

* **Flag & Suspend Cards**: You can now flag cards (🚩) for future attention or suspend them (⏸️) to temporarily remove them from reviews and content gating without deletion. Manage these states from the review modal, the edit screen, or the updated Card Browser.
* **Custom AI Guidance**: When generating cards, you can now provide custom instructions to the AI (e.g., "the answer (back) should only be names of people and places or dates") to tailor the output to your exact needs.
* **Card Preview in Editor**: The card edit modal now has a "Preview" tab, so you can see exactly how your Markdown will render before saving.
* **Reset Chapter Progress**: A new command allows you to reset the entire review history for a chapter, setting all its cards back to "new" without having to delete and regenerate them.
* **Image Analysis Management**: New commands let you remove cached AI analysis for images in the current note or for all images in your vault, giving you control over your data.

### 🚀 Enhancements

* **Smarter Image Analysis**: The AI now uses the text surrounding an image as context, leading to much more accurate and relevant analysis of diagrams, charts, and photos. It's now focused on extracting `key_facts` that are perfect for flashcards.
* **More Intelligent Card Generation**: The AI prompt has been overhauled to generate more diverse and useful cards, including:
    * Cards that test factual knowledge extracted directly from diagrams.
    * "Visual questions" that require you to see the image to answer.
* **Seamless Content Unlocking**: The review flow is now much smoother. When you answer cards correctly and unlock a new paragraph, the plugin will automatically scroll to and highlight the newly revealed content.
* **Improved Card Browser**: The browser can now filter to show only flagged or suspended cards, making it easy to manage your collection.
* **Better AI "Refocus"**: The prompt for the "Refocus with AI" feature has been improved to generate more accurate "reverse" cards.

### 🐛 Bug Fixes & Quality of Life

* The content unlocking mechanism during reviews has been made more robust to prevent edge cases where content might not unblur correctly.
* The Card Browser now correctly refreshes its list after a card has been edited or deleted.
* Fixed various UI layout issues within the card edit modal.

# v2.0.1

# v2.0.0

# v1.0.1

# v1.0.0
