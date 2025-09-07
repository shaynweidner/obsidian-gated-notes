/**
 * Navigation-Aware Modal System
 * 
 * Extends Obsidian's Modal class to integrate with the navigation stack
 * and provide consistent back navigation, breadcrumbs, and context preservation.
 */

import { Modal, App, ButtonComponent } from "obsidian";
import { 
    navigationStack, 
    AnyNavigationContext, 
    NavigationContextType 
} from "./navigation-stack";
import type GatedNotesPlugin from "./main";

/**
 * Base class for all modals that participate in the navigation stack
 */
export abstract class NavigationAwareModal extends Modal {
    protected plugin: GatedNotesPlugin;
    protected context: AnyNavigationContext | null = null;
    private breadcrumbContainer: HTMLElement | null = null;
    private backButton: ButtonComponent | null = null;

    constructor(app: App, plugin: GatedNotesPlugin) {
        super(app);
        this.plugin = plugin;
    }

    /**
     * Override to define the navigation context for this modal
     * Called before the modal opens to set up navigation state
     */
    protected abstract createNavigationContext(): AnyNavigationContext;

    /**
     * Override to handle restoration from a navigation context
     * Called when returning to this modal via back navigation
     */
    protected abstract restoreFromContext(context: AnyNavigationContext): void;

    /**
     * Override to handle cleanup when navigating away
     * Return false to prevent navigation (e.g., unsaved changes)
     */
    protected onNavigateAway(): boolean {
        return true; // Allow navigation by default
    }

    /**
     * Override to save current state to context before navigating
     * Called before pushing new context or closing modal
     */
    protected saveToContext(): void {
        // Default: no special save logic
    }

    /**
     * Enhanced open method that handles navigation stack
     */
    public openWithNavigation(restoreContext?: AnyNavigationContext): void {
        if (restoreContext) {
            // Restoring from navigation stack
            this.context = restoreContext;
            this.open();
            this.restoreFromContext(restoreContext);
        } else {
            // Fresh open - create new context
            this.context = this.createNavigationContext();
            navigationStack.push(this.context);
            this.open();
        }
    }

    /**
     * Navigate to another modal while preserving this one in the stack
     */
    protected navigateTo(targetModal: NavigationAwareModal): void {
        if (!this.onNavigateAway()) {
            return; // Navigation blocked (e.g., unsaved changes)
        }

        // Save current state
        this.saveToContext();

        // Close current modal and open target
        this.close();
        targetModal.openWithNavigation();
    }

    /**
     * Navigate back to the previous context in the stack
     */
    protected navigateBack(): void {
        if (!this.onNavigateAway()) {
            return; // Navigation blocked
        }

        // Save current state before popping
        this.saveToContext();

        // Pop current context
        const currentContext = navigationStack.pop();
        
        // Get previous context
        const previousContext = navigationStack.peek();
        
        if (previousContext) {
            // Navigate back to previous modal
            this.close();
            this.reopenModalFromContext(previousContext);
        } else {
            // No previous context, just close
            this.close();
        }
    }

    /**
     * Factory method to create appropriate modal from context
     */
    private reopenModalFromContext(context: AnyNavigationContext): void {
        let modal: NavigationAwareModal;

        switch (context.type) {
            case NavigationContextType.REVIEW_SESSION:
                // Note: Review sessions are handled differently as they're not modals
                // For now, we'll just close and let the user restart review
                console.log("NavigationAwareModal: Cannot restore review session - not implemented");
                return;
                
            case NavigationContextType.CARD_BROWSER:
                modal = new (require("./main").CardBrowser)(this.plugin, this.plugin.cardBrowserState);
                break;
                
            case NavigationContextType.EDIT_MODAL:
                // We need access to the EditModal class and the card data
                // This will need to be implemented when we update the existing modals
                console.log("NavigationAwareModal: Edit modal restoration not yet implemented");
                return;
                
            case NavigationContextType.MNEMONICS_MODAL:
                console.log("NavigationAwareModal: Mnemonics modal restoration not yet implemented");
                return;
                
            default:
                console.warn(`NavigationAwareModal: Unknown context type: ${context.type}`);
                return;
        }

        modal.openWithNavigation(context);
    }

    /**
     * Enhanced onOpen that adds navigation UI elements
     */
    onOpen(): void {
        this.addNavigationUI();
        this.onOpenContent();
    }

    /**
     * Subclasses should override this instead of onOpen
     */
    protected abstract onOpenContent(): void;

    /**
     * Add breadcrumb and back button UI elements
     */
    private addNavigationUI(): void {
        // Only show navigation UI if we're not the only item in the stack
        const stackSize = navigationStack.size();
        if (stackSize <= 1) {
            return;
        }

        // Create breadcrumb container
        this.breadcrumbContainer = this.titleEl.createDiv({
            cls: "navigation-breadcrumbs",
            attr: { style: "margin-bottom: 10px; font-size: 12px; color: var(--text-muted);" }
        });

        this.updateBreadcrumbs();

        // Add back button to header
        const headerActions = this.titleEl.createDiv({
            cls: "modal-header-actions",
            attr: { style: "position: absolute; right: 30px; top: 50%; transform: translateY(-50%);" }
        });

        this.backButton = new ButtonComponent(headerActions)
            .setButtonText(navigationStack.getBackToMessage())
            .setClass("mod-muted")
            .onClick(() => this.navigateBack());
    }

    /**
     * Update breadcrumb display
     */
    private updateBreadcrumbs(): void {
        if (!this.breadcrumbContainer) return;

        this.breadcrumbContainer.empty();

        const breadcrumbs = navigationStack.getBreadcrumbs();
        
        breadcrumbs.forEach((breadcrumb, index) => {
            if (index > 0) {
                this.breadcrumbContainer!.createSpan({
                    text: " › ",
                    attr: { style: "color: var(--text-faint);" }
                });
            }

            const isLast = index === breadcrumbs.length - 1;
            this.breadcrumbContainer!.createSpan({
                text: breadcrumb.title,
                cls: isLast ? "breadcrumb-current" : "breadcrumb-link",
                attr: { 
                    style: isLast 
                        ? "font-weight: 500;" 
                        : "color: var(--text-accent); cursor: pointer;"
                }
            }).onclick = isLast ? null : () => {
                // Navigate to specific breadcrumb level
                this.navigateToContext(breadcrumb.context);
            };
        });
    }

    /**
     * Navigate to a specific context in the stack
     */
    private navigateToContext(targetContext: AnyNavigationContext): void {
        if (!this.onNavigateAway()) {
            return;
        }

        // Pop contexts until we reach the target
        let poppedContext = navigationStack.pop();
        while (poppedContext && poppedContext.id !== targetContext.id) {
            poppedContext = navigationStack.pop();
        }

        // Reopen the target modal
        this.close();
        this.reopenModalFromContext(targetContext);
    }

    /**
     * Enhanced close method that handles navigation cleanup
     */
    onClose(): void {
        // Clean up navigation UI
        this.breadcrumbContainer = null;
        this.backButton = null;

        // Call subclass cleanup
        this.onCloseContent();

        // If this modal was closed without navigation (e.g., X button or ESC),
        // we should pop its context from the stack
        const currentContext = navigationStack.peek();
        if (currentContext && this.context && currentContext.id === this.context.id) {
            navigationStack.pop();
        }
    }

    /**
     * Subclasses should override this instead of onClose
     */
    protected onCloseContent(): void {
        // Default: no cleanup needed
    }

    /**
     * Utility method to generate unique context ID
     */
    protected generateContextId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Check if this modal is at the top of the navigation stack
     */
    protected isTopOfStack(): boolean {
        const topContext = navigationStack.peek();
        return topContext?.id === this.context?.id;
    }
}

/**
 * Special handling for review sessions which aren't modals
 * This utility helps preserve review state during navigation
 */
export class ReviewSessionManager {
    private static currentSession: any = null;

    static saveSession(sessionData: any): void {
        ReviewSessionManager.currentSession = sessionData;
    }

    static restoreSession(): any {
        const session = ReviewSessionManager.currentSession;
        ReviewSessionManager.currentSession = null; // Clear after restore
        return session;
    }

    static hasSession(): boolean {
        return ReviewSessionManager.currentSession !== null;
    }

    static clearSession(): void {
        ReviewSessionManager.currentSession = null;
    }
}