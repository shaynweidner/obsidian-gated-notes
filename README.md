# Gated Notes 🧠

**AI-powered, gated reading and spaced repetition for Obsidian.**

**Gated Notes** is an Obsidian plugin that transforms reading into an active learning process. Inspired by [Andy Matuschak and Michael Nielsen’s concept of the “Mnemonic Medium”](https://numinous.productions/ttft/#introducing-mnemonic-medium), it combines **gated reading** with an **SM-2 spaced repetition system** and **AI-driven flashcard generation**.

Instead of passively consuming information, you must _earn_ your way through a note: later sections remain blurred until you’ve correctly answered flashcards tied to earlier sections.

---

## ✨ Key Features

- **Gated Reading:** Locks later paragraphs in a note until you’ve mastered the flashcards for the current section.
    
- **AI-Powered Flashcards:** Create cards automatically using OpenAI or a local LM Studio instance.
    
- **Advanced AI Tools:**
    
    - **Split Card:** Break a complex card into smaller, more atomic ones.
        
    - **Refocus Card:** Generate alternate phrasings/questions for the same fact.
        
- **SM-2 Scheduling:** Built-in spaced repetition ensures maximum retention.
    
- **Multiple Study Modes:**
    
    - **🎯 Chapter Mode:** Review cards for the current chapter in gated reading.
        
    - **📚 Subject Mode:** Review all cards in a subject folder.
        
    - **🧠 Review Mode:** Study all due cards vault-wide.
        
- **Rich UI Enhancements:**
    
    - Status bar due-card counter.
        
    - File explorer icons showing chapter status (`⏳` blocked, `📆` due, `✅` done).
        
    - Full card browser with filters and inline editing.
        

---

## 🚀 Core Workflow

### 1. **Write or Import Notes**

Treat each note as a “chapter” within a subject (folder). Write normally in Markdown.

### 2. **Finalize the Chapter**

Prepare the note for gating by converting paragraphs into trackable units.

- **Auto Finalize:**  
    `Gated Notes: Finalize note (auto)` — splits on double newlines.
    
- **Manual Finalize:**  
    Insert split markers (`Mod+Shift+Enter`) where you want breaks, then run  
    `Gated Notes: Finalize note (manual)`.
    

### 3. **Generate or Add Cards**

- **AI Generation:**  
    `Gated Notes: Generate flashcards from finalized note` — specify number of cards and model.
    
- **Manual Creation:**  
    Highlight text → right-click → “Add flashcard (manual)” or “Generate with AI.”
    

### 4. **Study to Unlock Content**

- Open a gated note — only the first section is visible.
    
- Start a review in **Chapter Mode**.
    
- As you answer correctly, the next section unblurs automatically.
    

---

## 🛠 Installation & Setup

1. **Install via BRAT** (Beta Reviewers Auto-update Tester):
    
    - Install BRAT from Community Plugins.
        
    - Add this repo’s GitHub path in BRAT’s settings.
        
2. **Configure AI Provider**:
    
    - Choose **OpenAI** or **LM Studio** in plugin settings.
        
    - Enter API key (OpenAI) or local server URL (LM Studio).
        
    - Click **Fetch Models** to load available models.
        
3. **Optional Settings**:
    
    - Adjust gating behavior (blur style, unlocked section count).
        
    - Enable/disable auto-advance after answering.
        

---

## ⚙️ Key Commands

|Command|Description|
|---|---|
|`Review due cards`|Starts a review session for the current mode.|
|`Toggle content gating`|Enable/disable blur without changing settings.|
|`Browse cards`|Open the Card Browser.|
|`Finalize note (auto/manual)`|Prepare note for gating.|
|`Un-finalize chapter`|Revert to plain Markdown.|
|`Recalculate paragraph indexes`|Re-sync all cards with their source text.|
|`Delete all flashcards for this chapter`|Remove all cards tied to the active note.|

---

## ❤️ Contributing

Contributions, bug reports, and feature requests are welcome!  
Open an issue or PR on [GitHub](https://github.com/shaynweidner/obsidian-gated-notes).


