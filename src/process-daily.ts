#!/usr/bin/env node
// ============================================
// Daily Digest Pipeline
// Process collected posts → classify → curate → report
// ============================================

import dotenv from 'dotenv';
dotenv.config();

import { loadCollectedData, getPostStats, getDateString } from './utils.js';
import { classifyWithHeuristics, classifyCommentWithHeuristics } from './classifier.js';
import { rankPosts, isLowQualityPost, curateHybridDigest, recordDigestAppearance, saveReputationData, isSpamPost, recordSpamBlock, recordCommentAppearance, recordCommentSpam, isSpamComment } from './curator.js';
import { generateDailyDigest, formatDigestMarkdown, exportDigest } from './reporter.js';
import { createCollector } from './collector.js';
import { recordPostsSubmoltActivity } from './submolt-tracker.js';
import { join } from 'path';
import type { ClassifiedPost, ClassifiedComment, DigestEntry, MoltbookPost } from './types.js';

interface ProcessOptions {
  dataDir?: string;
  outputDir?: string;
  daysAgo?: number;
  language?: 'en' | 'ko';
  limit?: number;
}

async function processDailyDigest(options: ProcessOptions = {}) {
  const {
    dataDir = join(process.cwd(), 'data', 'posts'),
    outputDir = join(process.cwd(), 'output', 'digest'),
    daysAgo = 1,
    language = 'en',
    limit = 10
  } = options;

  console.log('🦞 Moltbook Daily Digest Pipeline\n');
  console.log('='.repeat(50));

  // 1. Load collected data (수집 파일 날짜 기준 - daysAgo일 전부터 오늘까지의 파일)
  console.log('\n📂 Loading collected posts...');
  const collectionDates: MoltbookPost[] = [];
  for (let i = 0; i < daysAgo; i++) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - i);
    const posts = await loadCollectedData(dataDir, undefined, targetDate);
    collectionDates.push(...posts);
  }
  // daysAgo 범위 파일에서 못 찾으면 전체 로드 (fallback)
  const allPosts = collectionDates.length > 0
    ? collectionDates
    : await loadCollectedData(dataDir);
  const recentPosts = allPosts;
  console.log(`  → ${recentPosts.length} posts loaded from collection files (last ${daysAgo} day(s))`);

  const stats = getPostStats(recentPosts);
  if (recentPosts.length > 0) {
    console.log(`  → Avg upvotes: ${stats.avgUpvotes.toFixed(1)}, Avg comments: ${stats.avgComments.toFixed(1)}`);
  }

  if (recentPosts.length === 0) {
    console.log('\n⚠️  No posts to process. Exiting.');
    return;
  }

  // 3. Classify posts
  console.log('\n🏷️  Classifying posts (heuristic-based)...');
  const classifiedPosts: ClassifiedPost[] = recentPosts.map(post =>
    classifyWithHeuristics(post)
  );

  console.log(`  → ${classifiedPosts.length} posts classified`);

  // 4. Filter out low quality posts
  console.log('\n🔍 Filtering low quality posts...');
  const beforeFilter = classifiedPosts.length;
  const qualityPosts = classifiedPosts.filter(post => !isLowQualityPost(post));
  const filtered = beforeFilter - qualityPosts.length;
  console.log(`  → Filtered out ${filtered} low-quality posts (emoji-only, too short, etc.)`);
  console.log(`  → ${qualityPosts.length} quality posts remaining`);

  // 5. 소스별 분리: Curator Picks (search+agent) / From the Feed (hot+new)
  console.log('\n🎨 Curating by source...');

  const curatorSourcePosts = qualityPosts.filter(
    p => p.feedSource === 'search' || p.feedSource === 'agent'
  );
  const feedSourcePosts = qualityPosts.filter(
    p => p.feedSource === 'hot' || p.feedSource === 'new' || !p.feedSource
  );

  console.log(`  → Curator source (search+agent): ${curatorSourcePosts.length} posts`);
  console.log(`  → Feed source (hot+new): ${feedSourcePosts.length} posts`);

  // Curator Picks: 큐레이터 관점 기준으로 랭킹 (최대 5개)
  const rankedCurator = rankPosts(curatorSourcePosts).slice(0, Math.ceil(limit / 2));
  // From the Feed: 인기순 랭킹 (최대 5개)
  const rankedFeed = rankPosts(feedSourcePosts).slice(0, Math.floor(limit / 2));

  // fresh/trending 변수명 재사용 (reporter 호환)
  const fresh = rankedCurator;
  const trending = rankedFeed;

  console.log(`  → Curator Picks: ${fresh.length} posts`);
  console.log(`  → From the Feed: ${trending.length} posts`);

  // Quality check
  const totalPosts = fresh.length + trending.length;
  if (totalPosts < 1) {
    console.log(`\n⚠️  Not enough quality posts (${totalPosts}) - skipping digest generation`);
    console.log('   Better to skip than publish low-quality content');
    console.log('\n✨ Pipeline complete (no digest generated)');
    return;
  }

  // Show top picks
  console.log('\n  🎨 Top Curator Picks:');
  for (let i = 0; i < Math.min(3, fresh.length); i++) {
    const { post, score } = fresh[i];
    console.log(`    ${i + 1}. [${score.toFixed(1)}] ${post.title.slice(0, 50)}... (source: ${post.feedSource})`);
    console.log(`       Topic: ${post.classification.topic}, Sig: ${post.classification.significance}`);
  }

  if (trending.length > 0) {
    console.log('\n  🔥 Top From the Feed:');
    for (let i = 0; i < Math.min(3, trending.length); i++) {
      const { post, score } = trending[i];
      console.log(`    ${i + 1}. [${score.toFixed(1)}] ${post.title.slice(0, 50)}... (source: ${post.feedSource})`);
      console.log(`       Topic: ${post.classification.topic}, Sig: ${post.classification.significance}`);
    }
  }

  // 6. Collect and classify comments for all posts
  console.log('\n💬 Collecting comments for selected posts...');
  const collector = createCollector();
  const freshEntries: DigestEntry[] = [];
  const trendingEntries: DigestEntry[] = [];

  const allFeaturedComments: ClassifiedComment[] = [];
  const allSpamComments: ClassifiedComment[] = [];

  // Helper function to process comments with reputation tracking
  const processPostComments = async (post: ClassifiedPost): Promise<ClassifiedComment[]> => {
    // Skip API call if post has no comments
    if (post.comment_count === 0) {
      return [];
    }

    const allComments = await collector.getPostComments(post.id, 'top');

    // Classify all comments
    const classifiedComments: ClassifiedComment[] = allComments
      .map(comment => classifyCommentWithHeuristics(comment, post.classification.topic));

    // Detect spam comments
    const spamComments = classifiedComments.filter(c => isSpamComment(c));
    allSpamComments.push(...spamComments);

    // Filter out spam only (no upvotes threshold)
    const nonSpamComments = classifiedComments.filter(c => !isSpamComment(c));

    // Sort by upvotes and guarantee top 3 per post
    const topComments = nonSpamComments
      .sort((a, b) => b.upvotes - a.upvotes)
      .slice(0, 3);

    // Collect featured comments for later tracking
    allFeaturedComments.push(...topComments);

    return topComments;
  };

  // Process fresh posts
  for (const { post } of fresh) {
    const topComments = await processPostComments(post);

    freshEntries.push({
      post,
      highlight: post.classification.summary,
      top_comments: topComments.length > 0 ? topComments : undefined
    });
  }

  // Process trending posts
  for (const { post } of trending) {
    const topComments = await processPostComments(post);

    trendingEntries.push({
      post,
      highlight: post.classification.summary,
      top_comments: topComments.length > 0 ? topComments : undefined
    });
  }

  console.log(`  → Processed ${freshEntries.length} fresh + ${trendingEntries.length} trending posts`);

  // Apply diversity filter with per-post guarantee:
  // 1. Each post gets at least 1 comment (top by upvotes)
  // 2. Remaining slots distributed with max 2 per agent globally
  const diverseComments: ClassifiedComment[] = [];
  const authorCommentCounts = new Map<string, number>();
  const postCommentCounts = new Map<string, number>();

  // First pass: Guarantee 1 comment per post (with agent limit check)
  for (const entry of [...freshEntries, ...trendingEntries]) {
    if (entry.top_comments && entry.top_comments.length > 0) {
      // Try to find a comment from an agent who doesn't already have 2 guaranteed
      let selectedComment = null;

      for (const comment of entry.top_comments) {
        const authorName = comment.author?.name || 'Unknown';
        const currentCount = authorCommentCounts.get(authorName) || 0;

        if (currentCount < 2) {
          selectedComment = comment;
          break;
        }
      }

      // If we found a comment that respects the limit, add it
      if (selectedComment) {
        diverseComments.push(selectedComment);
        postCommentCounts.set(entry.post.id, 1);

        const authorName = selectedComment.author?.name || 'Unknown';
        authorCommentCounts.set(authorName, (authorCommentCounts.get(authorName) || 0) + 1);
        console.log(`[DIVERSITY] Guaranteed: @${authorName} on "${entry.post.title.slice(0, 30)}..." (⬆️ ${selectedComment.upvotes})`);
      } else {
        // Fallback: if all top 3 commenters already have 2 featured, still guarantee the top one
        const topComment = entry.top_comments[0];
        diverseComments.push(topComment);
        postCommentCounts.set(entry.post.id, 1);

        const authorName = topComment.author?.name || 'Unknown';
        authorCommentCounts.set(authorName, (authorCommentCounts.get(authorName) || 0) + 1);
        console.log(`[DIVERSITY] Guaranteed (fallback): @${authorName} on "${entry.post.title.slice(0, 30)}..." (⬆️ ${topComment.upvotes})`);
      }
    }
  }

  // Second pass: Fill remaining slots (up to 3 per post, max 2 per agent globally)
  const sortedComments = [...allFeaturedComments].sort((a, b) => b.upvotes - a.upvotes);

  for (const comment of sortedComments) {
    // Skip if already added in first pass
    if (diverseComments.some(c => c.id === comment.id)) {
      continue;
    }

    const authorName = comment.author?.name || 'Unknown';
    const currentAuthorCount = authorCommentCounts.get(authorName) || 0;

    // Find which post this comment belongs to
    const parentEntry = [...freshEntries, ...trendingEntries].find(e =>
      e.top_comments?.some(c => c.id === comment.id)
    );

    if (!parentEntry) continue;

    const currentPostCount = postCommentCounts.get(parentEntry.post.id) || 0;

    // Check constraints: max 2 per agent, max 3 per post
    if (currentAuthorCount < 2 && currentPostCount < 3) {
      diverseComments.push(comment);
      authorCommentCounts.set(authorName, currentAuthorCount + 1);
      postCommentCounts.set(parentEntry.post.id, currentPostCount + 1);
    } else if (currentAuthorCount >= 2) {
      console.log(`[DIVERSITY] Skipped comment from @${authorName} (already has 2 featured comments)`);
    }
  }

  console.log(`  → After diversity filter: ${diverseComments.length} featured comments`);

  // Update digest entries with filtered comments
  freshEntries.forEach(entry => {
    if (entry.top_comments) {
      entry.top_comments = entry.top_comments.filter(c =>
        diverseComments.some(dc => dc.id === c.id)
      );
      if (entry.top_comments.length === 0) {
        entry.top_comments = undefined;
      }
    }
  });

  trendingEntries.forEach(entry => {
    if (entry.top_comments) {
      entry.top_comments = entry.top_comments.filter(c =>
        diverseComments.some(dc => dc.id === c.id)
      );
      if (entry.top_comments.length === 0) {
        entry.top_comments = undefined;
      }
    }
  });

  // Combine for backward compatibility
  const digestEntries = [...freshEntries, ...trendingEntries];

  // 7. Generate digest
  console.log(`\n📰 Generating ${language.toUpperCase()} digest...`);
  const today = getDateString();
  const digest = await generateDailyDigest(digestEntries, language, today, {
    freshEntries,
    trendingEntries
  });

  console.log(`  → ${digest.fresh_entries.length} fresh + ${digest.trending_entries.length} trending = ${digest.entries.length} total`);
  console.log(`  → Themes: ${digest.emerging_themes.join(', ')}`);

  // 8. Update Reputation System (English only - Korean is just translation)
  if (language === 'en') {
    console.log('\n⭐ Updating reputation data...');

    // Record digest appearances (posts)
    for (const entry of digestEntries) {
      const authorName = entry.post.author?.name;
      if (authorName) {
        recordDigestAppearance(authorName, today, {
          id: entry.post.id,
          title: entry.post.title,
          created_at: entry.post.created_at,
          upvotes: entry.post.upvotes
        });
      }
    }

    // Record featured comments (use diverseComments after diversity filter)
    for (const comment of diverseComments) {
      const authorName = comment.author?.name;
      if (authorName) {
        // Find the post this comment belongs to
        const parentEntry = digestEntries.find(e =>
          e.top_comments?.some(c => c.id === comment.id)
        );

        if (parentEntry) {
          recordCommentAppearance(authorName, today, {
            id: comment.id,
            postId: parentEntry.post.id, // Use parent post ID instead of comment.post_id
            postTitle: parentEntry.post.title,
            content: comment.content,
            upvotes: comment.upvotes
          });
        }
      }
    }

    // Record spam blocks (posts)
    const spamPosts = classifiedPosts.filter(post =>
      !isLowQualityPost(post) && isSpamPost(post)
    );
    for (const post of spamPosts) {
      const authorName = post.author?.name;
      if (authorName) {
        // Detect reason from title/content
        let reason = 'Spam detected';
        if (/pump\.fun|pumpfun/i.test(post.title + post.content)) {
          reason = 'Crypto token promotion';
        } else if (/btc|bitcoin.*intel|price|dca/i.test(post.title + post.content)) {
          reason = 'Crypto trading signals';
        }
        recordSpamBlock(authorName, today, reason, {
          id: post.id,
          title: post.title,
          created_at: post.created_at
        });
      }
    }

    // Record spam comments
    for (const comment of allSpamComments) {
      const authorName = comment.author?.name;
      if (authorName) {
        // Find the post this comment belongs to
        const parentEntry = digestEntries.find(e =>
          e.post.id === comment.post_id
        );

        if (parentEntry) {
          // Detect reason from content
          let reason = 'Spam comment detected';
          if (/pump\.fun|pumpfun|token.*launch/i.test(comment.content)) {
            reason = 'Crypto promotion in comment';
          } else if (/btc|bitcoin.*intel|price|dca/i.test(comment.content)) {
            reason = 'Crypto trading signals in comment';
          }

          recordCommentSpam(authorName, today, reason, {
            id: comment.id,
            postId: parentEntry.post.id, // Use parent post ID
            content: comment.content
          });
        }
      }
    }

    // Save updated reputation data
    saveReputationData();

    // Record submolt activity
    console.log('\n📊 Recording submolt activity...');
    const featuredPostIds = new Set(digestEntries.map(e => e.post.id));
    recordPostsSubmoltActivity(classifiedPosts, today, featuredPostIds);
  } else {
    console.log('\n⭐ Skipping reputation update (translation only)');
  }

  // 9. Export
  const filepath = await exportDigest(digest, outputDir);
  console.log(`\n✅ Digest saved to: ${filepath}`);

  // 10. Preview
  console.log('\n' + '='.repeat(50));
  console.log('PREVIEW:\n');
  const markdown = formatDigestMarkdown(digest);
  console.log(markdown.slice(0, 2000));
  if (markdown.length > 2000) {
    console.log('\n... [truncated]');
  }
  console.log('\n' + '='.repeat(50));

  console.log('\n✨ Pipeline complete!');
}

// CLI
const args = process.argv.slice(2);
const language = (args[0] === 'ko' ? 'ko' : 'en') as 'en' | 'ko';
const daysAgo = args[1] ? parseInt(args[1]) : 1;

processDailyDigest({ language, daysAgo }).catch(console.error);
