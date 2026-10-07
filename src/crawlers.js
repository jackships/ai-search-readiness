import { readFileSync } from 'node:fs';

/**
 * @typedef {{ token: string, operator: string, purpose: 'search' | 'user' | 'training' | 'search-engine',
 *             description: string, docs: string | null }} Crawler
 */

/** @type {Crawler[]} */
export const AI_CRAWLERS = JSON.parse(readFileSync(new URL('../data/ai-crawlers.json', import.meta.url), 'utf8')).crawlers;

/** Crawlers whose access decides whether you can be found and cited in AI answers. */
export const isVisibilityCrawler = (c) => c.purpose !== 'training';
