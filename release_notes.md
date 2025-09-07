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
