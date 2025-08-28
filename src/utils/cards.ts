export const isUnseen = (card: any): boolean =>
	card.status === "new" &&
	(card.learning_step_index == null || card.learning_step_index === 0);
