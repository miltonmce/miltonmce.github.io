import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content', // Importante: define que es contenido Markdown
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()),
    lang: z.enum(['es', 'en']).default('es'),
  }),
});

export const collections = {
  'blog': blog, // Esta llave debe coincidir con el nombre de tu carpeta
};