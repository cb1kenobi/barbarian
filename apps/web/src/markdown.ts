import { renderMarkdown as renderSharedMarkdown } from '../../chrome-extension/src/markdown.js';

export const renderMarkdown: (value?: string) => string = renderSharedMarkdown;
