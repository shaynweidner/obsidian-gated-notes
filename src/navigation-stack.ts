/**
 * Navigation Stack System for Context Preservation
 * 
 * Manages a stack of navigation contexts to allow proper back navigation
 * and preservation of review sessions, modal states, etc.
 */

import { Flashcard, CardVariant } from "./main";

// Base interface for all navigation contexts
export interface NavigationContext {
    type: NavigationContextType;
    id: string; // Unique identifier for this context
    title: string; // Human-readable title for breadcrumbs
    timestamp: number;
}

export enum NavigationContextType {
    REVIEW_SESSION = "review_session",
    CARD_BROWSER = "card_browser", 
    EDIT_MODAL = "edit_modal",
    MNEMONICS_MODAL = "mnemonics_modal",
    REFOCUS_OPTIONS = "refocus_options",
    SPLIT_OPTIONS = "split_options",
    GENERATE_CARDS = "generate_cards",
    VARIANT_OPTIONS = "variant_options"
}

// Specific context types for different navigation states
export interface ReviewSessionContext extends NavigationContext {
    type: NavigationContextType.REVIEW_SESSION;
    currentCardIndex: number;
    remainingCards: Flashcard[];
    studyMode: string;
    sessionStats: {
        cardsReviewed: number;
        startTime: number;
    };
}

export interface CardBrowserContext extends NavigationContext {
    type: NavigationContextType.CARD_BROWSER;
    searchQuery?: string;
    selectedDeckPath?: string;
    selectedChapterPath?: string;
    scrollPosition?: number;
    selectedFolders?: Set<string>;
}

export interface EditModalContext extends NavigationContext {
    type: NavigationContextType.EDIT_MODAL;
    cardId: string;
    deckPath: string;
    hasUnsavedChanges: boolean;
    originalCard?: Flashcard; // For rollback if needed
}

export interface MnemonicsModalContext extends NavigationContext {
    type: NavigationContextType.MNEMONICS_MODAL;
    cardId: string;
    variant: CardVariant;
}

export interface RefocusOptionsContext extends NavigationContext {
    type: NavigationContextType.REFOCUS_OPTIONS;
    sourceCardId: string;
    deckPath: string;
}

export interface SplitOptionsContext extends NavigationContext {
    type: NavigationContextType.SPLIT_OPTIONS;
    sourceCardId: string;
    deckPath: string;
}

export interface GenerateCardsContext extends NavigationContext {
    type: NavigationContextType.GENERATE_CARDS;
    generatedCards: Flashcard[];
    sourceAction: "refocus" | "split";
    sourceCardId?: string;
}

export interface VariantOptionsContext extends NavigationContext {
    type: NavigationContextType.VARIANT_OPTIONS;
    cardId: string;
    deckPath: string;
}

// Union type for all possible contexts
export type AnyNavigationContext = 
    | ReviewSessionContext
    | CardBrowserContext  
    | EditModalContext
    | MnemonicsModalContext
    | RefocusOptionsContext
    | SplitOptionsContext
    | GenerateCardsContext
    | VariantOptionsContext;

/**
 * Navigation Stack Manager
 * 
 * Manages the navigation context stack and provides methods for
 * pushing/popping contexts with proper cleanup and restoration.
 */
export class NavigationStack {
    private stack: AnyNavigationContext[] = [];
    private maxStackSize = 10; // Prevent memory leaks
    
    /**
     * Push a new context onto the stack
     */
    push(context: AnyNavigationContext): void {
        // Add timestamp
        context.timestamp = Date.now();
        
        // Add to stack
        this.stack.push(context);
        
        // Prevent stack overflow
        if (this.stack.length > this.maxStackSize) {
            this.stack.shift(); // Remove oldest
        }
        
        this.logStackOperation('PUSH', context);
    }
    
    /**
     * Pop the most recent context from the stack
     */
    pop(): AnyNavigationContext | null {
        const context = this.stack.pop() || null;
        if (context) {
            this.logStackOperation('POP', context);
        }
        return context;
    }
    
    /**
     * Peek at the most recent context without removing it
     */
    peek(): AnyNavigationContext | null {
        return this.stack[this.stack.length - 1] || null;
    }
    
    /**
     * Get the context at a specific depth (0 = top of stack)
     */
    peekAt(depth: number): AnyNavigationContext | null {
        const index = this.stack.length - 1 - depth;
        return (index >= 0 && index < this.stack.length) ? this.stack[index] : null;
    }
    
    /**
     * Find the most recent context of a specific type
     */
    findContextOfType<T extends AnyNavigationContext>(
        type: NavigationContextType
    ): T | null {
        for (let i = this.stack.length - 1; i >= 0; i--) {
            const context = this.stack[i];
            if (context.type === type) {
                return context as T;
            }
        }
        return null;
    }
    
    /**
     * Remove all contexts of a specific type from the stack
     * Useful when a context becomes invalid (e.g., card deleted)
     */
    removeContextsOfType(type: NavigationContextType): void {
        const originalLength = this.stack.length;
        this.stack = this.stack.filter(context => context.type !== type);
        
        if (this.stack.length !== originalLength) {
            console.log(`NavigationStack: Removed ${originalLength - this.stack.length} contexts of type ${type}`);
        }
    }
    
    /**
     * Clear the entire stack (e.g., on plugin unload)
     */
    clear(): void {
        this.stack = [];
        console.log('NavigationStack: Cleared all contexts');
    }
    
    /**
     * Get the current stack size
     */
    size(): number {
        return this.stack.length;
    }
    
    /**
     * Check if stack is empty
     */
    isEmpty(): boolean {
        return this.stack.length === 0;
    }
    
    /**
     * Generate breadcrumb trail for UI display
     */
    getBreadcrumbs(): Array<{title: string, context: AnyNavigationContext}> {
        return this.stack.map(context => ({
            title: context.title,
            context: context
        }));
    }
    
    /**
     * Generate a user-friendly "back to" message
     */
    getBackToMessage(): string {
        const previousContext = this.peekAt(1); // Get context before current
        if (!previousContext) {
            return "Close";
        }
        
        switch (previousContext.type) {
            case NavigationContextType.REVIEW_SESSION:
                return "← Back to Review";
            case NavigationContextType.CARD_BROWSER:
                return "← Back to Card Browser";
            case NavigationContextType.EDIT_MODAL:
                return "← Back to Edit Card";
            case NavigationContextType.MNEMONICS_MODAL:
                return "← Back to Mnemonics";
            default:
                return `← Back to ${previousContext.title}`;
        }
    }
    
    private logStackOperation(operation: 'PUSH' | 'POP', context: AnyNavigationContext): void {
        console.log(`NavigationStack ${operation}: ${context.type} - "${context.title}" (Stack size: ${this.stack.length})`);
    }
}

// Global navigation stack instance
export const navigationStack = new NavigationStack();