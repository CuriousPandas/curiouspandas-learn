import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const lessons = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/lessons' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    minutes: z.number().int().positive(),
    xp: z.number().int().positive(),
    tiers: z.array(z.enum(['browser', 'browser-plus', 'machine', 'codespace'])).min(1),
    // Lessons this one relies on: it uses what they teach without teaching it
    // again. Expeditions must place these earlier (src/lib/expeditions.ts).
    builds_on: z.array(z.string()).default([]),
    tiltLab: z.string().optional(),
    // Sources a reader can check. A lesson that states a number should say where it came from.
    sources: z.array(z.object({ title: z.string(), url: z.url() })).default([]),
  }),
});

export const collections = { lessons };
