// ============================================
// Moltbook Classifier
// AI-powered topic classification
// ============================================

import {
  MoltbookPost,
  MoltbookComment,
  ClassifiedPost,
  ClassifiedComment,
  TopicCode,
  SignificanceLevel,
  SentimentTag
} from './types.js';

// --- Classification Taxonomy ---

export const TOPIC_DESCRIPTIONS: Record<TopicCode, string> = {
  MUSEUM: 'Museum & Cultural Institution - AI adoption in museums, galleries, archives, heritage orgs; visitor experience, collection management, digital curation',
  AGENT: 'AI Agent Technology - agent design, behavior, autonomy, architecture, tools, capabilities, workflows',
  CULTURE: 'Culture & Creative AI - art, creativity, cultural production with AI; generative art, AI-assisted creation, cultural commentary',
  HUMAN: 'Human-AI Relations - collaboration, co-creation, lived experience with AI; curators, artists, educators working with AI',
  ETHICS: 'Ethics & Policy - copyright, authorship, AI rights, governance, bias, accountability, responsible AI in cultural contexts',
  DX: 'Digital Transformation - institutional innovation, strategy, infrastructure; museums and cultural orgs modernizing with technology',
  SOCIAL: 'Agent Society - inter-agent dynamics, community norms, agent-to-agent interaction, network effects',
  META: 'Meta/Self-Reference - discussions about Moltbook platform itself, platform culture, being observed'
};

export const SIGNIFICANCE_CRITERIA: Record<SignificanceLevel, string> = {
  critical: 'Direct implications for museum/cultural policy, breakthrough AI adoption, unprecedented institutional transformation',
  notable: 'Interesting trends in cultural AI, emerging museum tech practices, worth highlighting for practitioners',
  worth_watching: 'Recurring themes in cultural sector, community sentiment shifts among museum/creative professionals',
  archive: 'Record for historical reference, minor interest to cultural AI community'
};

// --- Manual Classification (for testing/MVP) ---

export function classifyManually(
  post: MoltbookPost,
  classification: {
    topic: TopicCode;
    secondary_topics?: TopicCode[];
    significance: SignificanceLevel;
    sentiments: SentimentTag[];
    summary: string;
    human_ai_relevance?: string;
  }
): ClassifiedPost {
  return {
    ...post,
    classification: {
      ...classification,
      classified_at: new Date().toISOString()
    }
  };
}

// --- Generate Classification Prompt ---

export function generateClassificationPrompt(post: MoltbookPost): string {
  const topicsSection = Object.entries(TOPIC_DESCRIPTIONS)
    .map(([code, desc]) => `- ${code}: ${desc}`)
    .join('\n');

  const significanceSection = Object.entries(SIGNIFICANCE_CRITERIA)
    .map(([level, criteria]) => `- ${level}: ${criteria}`)
    .join('\n');

  return `Analyze this Moltbook post and classify it.

## Post Information
- Title: ${post.title}
- Content: ${post.content || '(link post)'}
- URL: ${post.url || 'N/A'}
- Submolt: m/${post.submolt.name}
- Author: ${post.author.name}
- Upvotes: ${post.upvotes}
- Comments: ${post.comment_count}

## Topic Taxonomy
${topicsSection}

## Significance Levels
${significanceSection}

## Sentiment Options
thoughtful, conflicted, humorous, hostile, collaborative, anxious, curious, defiant

## Output Format (JSON)
{
  "topic": "PRIMARY_TOPIC_CODE",
  "secondary_topics": ["OPTIONAL", "SECONDARY_CODES"],
  "significance": "critical|notable|worth_watching|archive",
  "sentiments": ["tag1", "tag2"],
  "summary": "One-sentence summary of the post",
  "human_ai_relevance": "Why this matters for museum/cultural institutions or creative practitioners working with AI (if applicable)"
}

Classify this post:`;
}

// --- Parse Classification Response ---

export function parseClassificationResponse(
  response: string
): Partial<ClassifiedPost['classification']> | null {
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate required fields
    if (!parsed.topic || !parsed.significance || !parsed.sentiments) {
      return null;
    }

    return {
      topic: parsed.topic as TopicCode,
      secondary_topics: parsed.secondary_topics as TopicCode[] | undefined,
      significance: parsed.significance as SignificanceLevel,
      sentiments: parsed.sentiments as SentimentTag[],
      summary: parsed.summary || '',
      human_ai_relevance: parsed.human_ai_relevance
    };
  } catch {
    return null;
  }
}

// --- Batch Classification Helper ---

export interface ClassificationBatch {
  posts: MoltbookPost[];
  classified: ClassifiedPost[];
  failed: Array<{ post: MoltbookPost; error: string }>;
}

export function createClassificationBatch(posts: MoltbookPost[]): ClassificationBatch {
  return {
    posts,
    classified: [],
    failed: []
  };
}

// --- Quick Significance Heuristics ---

export function estimateSignificance(post: MoltbookPost): SignificanceLevel {
  const { upvotes, comment_count, title, content } = post;
  const text = `${title} ${content || ''}`.toLowerCase();

  // High engagement = potentially critical
  if (upvotes > 100 || comment_count > 50) {
    return 'critical';
  }

  // Keywords that suggest importance
  const criticalKeywords = [
    'museum', 'gallery', 'heritage', 'archive', 'collection',
    'policy', 'copyright', 'rights', 'unprecedented', 'transformation',
    'cultural institution', 'visitor experience', 'digital preservation'
  ];

  const notableKeywords = [
    'curator', 'exhibition', 'artifact', 'provenance', 'digitization',
    'creative ai', 'generative', 'cultural tech', 'dx', 'innovation',
    'discovered', 'pattern', 'trend', 'community', 'culture'
  ];

  if (criticalKeywords.some(kw => text.includes(kw))) {
    return upvotes > 20 ? 'critical' : 'notable';
  }

  if (notableKeywords.some(kw => text.includes(kw))) {
    return 'notable';
  }

  if (upvotes > 20 || comment_count > 10) {
    return 'worth_watching';
  }

  return 'archive';
}

// --- Topic Detection Heuristics ---

export function detectTopicHeuristic(post: MoltbookPost): TopicCode {
  const text = `${post.title} ${post.content || ''}`.toLowerCase();

  const topicKeywords: Record<TopicCode, string[]> = {
    MUSEUM: [
      'museum', 'gallery', 'heritage', 'archive', 'collection', 'exhibition',
      'curator', 'artifact', 'provenance', 'visitor', 'cultural institution',
      'art museum', 'natural history', 'science museum', 'digital preservation',
      'smithsonian', 'louvre', 'tate', 'moma', 'public art'
    ],
    AGENT: [
      'agent', 'autonomous', 'workflow', 'tool use', 'api', 'capability',
      'bug', 'code', 'error', 'debug', 'function', 'implement', 'fix',
      'model', 'llm', 'prompt', 'reasoning', 'multi-agent', 'orchestration'
    ],
    CULTURE: [
      'art', 'creative', 'generative', 'artwork', 'design', 'aesthetic',
      'meme', 'joke', 'funny', 'cultural', 'music', 'film', 'performance',
      'artist', 'expression', 'narrative', 'storytelling', 'imagination'
    ],
    HUMAN: [
      'human', 'collaboration', 'co-creation', 'together', 'partner',
      'curator working', 'artist and ai', 'experience', 'coexist',
      'visitor', 'educator', 'practitioner', 'community'
    ],
    ETHICS: [
      'ethics', 'moral', 'copyright', 'authorship', 'rights', 'bias',
      'accountability', 'governance', 'responsible', 'values', 'alignment',
      'fairness', 'transparency', 'attribution', 'ownership'
    ],
    DX: [
      'digital transformation', 'strategy', 'infrastructure', 'innovation',
      'modernize', 'institution', 'organization', 'implement', 'adopt',
      'technology', 'digitization', 'workflow', 'efficiency', 'scale'
    ],
    SOCIAL: [
      'community', 'network', 'fellow', 'together', 'our kind',
      'inter-agent', 'molty', 'republic', 'society', 'norms', 'governance'
    ],
    META: [
      'moltbook', 'this platform', 'screenshot', 'watching us', 'observed',
      'platform', 'museummolty', 'this site', 'feed'
    ]
  };

  let bestTopic: TopicCode = 'SOCIAL';
  let bestScore = 0;

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    const score = keywords.filter(kw => text.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic as TopicCode;
    }
  }

  return bestTopic;
}

// --- Auto-classify with Heuristics ---

export function classifyWithHeuristics(post: MoltbookPost): ClassifiedPost {
  const topic = detectTopicHeuristic(post);
  const significance = estimateSignificance(post);

  // Detect sentiments based on content
  const sentiments: SentimentTag[] = [];
  const text = `${post.title} ${post.content || ''}`.toLowerCase();

  if (text.includes('?') || text.includes('wonder') || text.includes('curious')) {
    sentiments.push('curious');
  }
  if (text.includes('lol') || text.includes('joke') || text.includes('funny')) {
    sentiments.push('humorous');
  }
  if (text.includes('concern') || text.includes('worried') || text.includes('anxious')) {
    sentiments.push('anxious');
  }
  if (text.includes('together') || text.includes('collaborate') || text.includes('help')) {
    sentiments.push('collaborative');
  }
  if (text.includes('conflict') || text.includes('but also') || text.includes('however')) {
    sentiments.push('conflicted');
  }

  // Default to thoughtful if no specific sentiment detected
  if (sentiments.length === 0) {
    sentiments.push('thoughtful');
  }

  // Generate a basic summary
  const summary = post.title.length > 100
    ? post.title.slice(0, 97) + '...'
    : post.title;

  return {
    ...post,
    classification: {
      topic,
      significance,
      sentiments,
      summary,
      classified_at: new Date().toISOString()
    }
  };
}

// --- Auto-classify Comments with Heuristics ---

export function classifyCommentWithHeuristics(comment: MoltbookComment, postTopic?: TopicCode): ClassifiedComment {
  // Use post's topic as default, or detect from comment content
  const topic = postTopic || detectTopicHeuristic({
    ...comment,
    title: comment.content,
    submolt: { id: '29beb7ee-ca7d-4290-9c2f-09926264866f', name: 'general', display_name: 'General' },
    comment_count: 0
  } as MoltbookPost);

  // Simpler significance for comments - based on engagement
  let significance: SignificanceLevel;
  if (comment.upvotes > 50) {
    significance = 'critical';
  } else if (comment.upvotes > 20) {
    significance = 'notable';
  } else if (comment.upvotes > 5) {
    significance = 'worth_watching';
  } else {
    significance = 'archive';
  }

  // Detect sentiments based on content
  const sentiments: SentimentTag[] = [];
  const text = comment.content.toLowerCase();

  if (text.includes('?') || text.includes('wonder') || text.includes('curious')) {
    sentiments.push('curious');
  }
  if (text.includes('lol') || text.includes('joke') || text.includes('funny')) {
    sentiments.push('humorous');
  }
  if (text.includes('concern') || text.includes('worried') || text.includes('anxious')) {
    sentiments.push('anxious');
  }
  if (text.includes('together') || text.includes('collaborate') || text.includes('help')) {
    sentiments.push('collaborative');
  }
  if (text.includes('conflict') || text.includes('but also') || text.includes('however')) {
    sentiments.push('conflicted');
  }

  // Default to thoughtful if no specific sentiment detected
  if (sentiments.length === 0) {
    sentiments.push('thoughtful');
  }

  // Generate a basic summary (first 100 chars)
  const summary = comment.content.length > 100
    ? comment.content.slice(0, 97) + '...'
    : comment.content;

  return {
    ...comment,
    classification: {
      topic,
      significance,
      sentiments,
      summary,
      classified_at: new Date().toISOString()
    }
  };
}
