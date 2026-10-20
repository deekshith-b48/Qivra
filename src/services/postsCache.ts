/**
 * Posts cache service — now backed by localDb (SQLite) instead of AsyncStorage.
 *
 * Post data (the main feed) is stored in the local SQLite database for:
 *   • No storage limits
 *   • Instant offline reads
 *   • No re-parsing from JSON on every launch
 *
 * Lightweight metadata (analyzing posts, failed posts, pending mutations)
 * remains in AsyncStorage since they are small and transient.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Post, FailedPost } from '../types';
import apiService from './api';
import localDb from './localDb';

const ANALYZING_POSTS_KEY = '@superbrain_analyzing_posts';
const FAILED_POSTS_KEY = '@superbrain_failed_posts';
const PENDING_MUTATIONS_KEY = '@superbrain_pending_post_mutations';
const PENDING_ANALYSES_KEY  = '@superbrain_pending_analyses';

type PendingPostMutation =
  | { type: 'delete'; shortcode: string }
  | { type: 'update'; shortcode: string; updates: Record<string, string> };

type PendingAnalysis = {
  url:           string;
  shortcode:     string;
  title:         string;
  thumbnail_url?: string;
  content_type?: string;
  queuedAt:      string;
};

class PostsCacheService {
  private analyzingPosts: Set<string> = new Set();

  // ── In-memory caches for lightweight metadata ─────────────────────
  private failedPostsCache: FailedPost[] | null = null;
  // Offline mutation queue — flushed next time online
  private pendingMutationsList: PendingPostMutation[] = [];
  // Offline analysis queue — URLs that couldn't reach backend, retried on reconnect
  private pendingAnalysesList: PendingAnalysis[] = [];

  constructor() {
    this.preWarm();
  }

  private async preWarm(): Promise<void> {
    try {
      const [analyzingRaw, failedRaw, pendingRaw, pendingAnalysesRaw] = await Promise.all([
        AsyncStorage.getItem(ANALYZING_POSTS_KEY),
        AsyncStorage.getItem(FAILED_POSTS_KEY),
        AsyncStorage.getItem(PENDING_MUTATIONS_KEY),
        AsyncStorage.getItem(PENDING_ANALYSES_KEY),
      ]);
      if (analyzingRaw) this.analyzingPosts = new Set(JSON.parse(analyzingRaw));
      if (failedRaw) this.failedPostsCache = JSON.parse(failedRaw);
      if (pendingRaw) this.pendingMutationsList = JSON.parse(pendingRaw);
      if (pendingAnalysesRaw) this.pendingAnalysesList = JSON.parse(pendingAnalysesRaw);
    } catch (e) {
      console.error('PostsCache preWarm error:', e);
    }
  }

  // ─── Pending post mutations (offline delete/update) ───────────────

  /** Queue a post delete/update to be flushed when online. */
  async enqueuePendingMutation(m: PendingPostMutation): Promise<void> {
    // De-duplicate: replace older entry with same type+shortcode
    this.pendingMutationsList = this.pendingMutationsList.filter(
      x => !(x.type === m.type && x.shortcode === m.shortcode)
    );
    this.pendingMutationsList.push(m);
    try {
      await AsyncStorage.setItem(PENDING_MUTATIONS_KEY, JSON.stringify(this.pendingMutationsList));
    } catch { /* best effort */ }
  }

  /** Replay queued post mutations. Removes ones that succeed or get 4xx. Keeps network failures. */
  async flushPendingPostMutations(): Promise<void> {
    if (this.pendingMutationsList.length === 0) return;
    const remaining: PendingPostMutation[] = [];
    for (const m of this.pendingMutationsList) {
      try {
        if (m.type === 'delete') {
          await apiService.deletePost(m.shortcode);
        } else if (m.type === 'update') {
          await apiService.updatePost(m.shortcode, m.updates);
        }
      } catch (e: any) {
        if (!e?.response) remaining.push(m); // network error — retry next time
        // HTTP error (4xx/5xx) = discard
      }
    }
    this.pendingMutationsList = remaining;
    try {
      if (remaining.length === 0) {
        await AsyncStorage.removeItem(PENDING_MUTATIONS_KEY);
      } else {
        await AsyncStorage.setItem(PENDING_MUTATIONS_KEY, JSON.stringify(remaining));
      }
    } catch { /* best effort */ }
  }

  hasPendingMutations(): boolean {
    return this.pendingMutationsList.length > 0;
  }

  // ─── Pending analysis queue (offline share → retry when reconnected) ────

  /** Queue a URL for analysis that couldn't reach the backend (offline). */
  async enqueuePendingAnalysis(a: PendingAnalysis): Promise<void> {
    // De-duplicate by shortcode
    this.pendingAnalysesList = this.pendingAnalysesList.filter(x => x.shortcode !== a.shortcode);
    this.pendingAnalysesList.push(a);
    try {
      await AsyncStorage.setItem(PENDING_ANALYSES_KEY, JSON.stringify(this.pendingAnalysesList));
    } catch { /* best effort */ }
  }

  /**
   * Replay queued analyses. For each URL:
   *   - Success / 202-quota → remove from queue, markAnalysisComplete so watcher picks it up
   *   - Network error       → keep in queue, placeholder stays alive
   *   - Other HTTP error    → discard (invalid URL etc.), mark failed
   */
  async flushPendingAnalyses(): Promise<void> {
    if (this.pendingAnalysesList.length === 0) return;
    const remaining: PendingAnalysis[] = [];
    for (const a of this.pendingAnalysesList) {
      try {
        await apiService.analyzeInstagramUrl(a.url);
        // Success: watcher will detect completion via getRecentPosts
        await this.markAnalysisComplete(a.shortcode);
      } catch (e: any) {
        if (e?.isRetryQueued) {
          // Backend accepted it (202) — backend handles retry, we're done
          await this.markAnalysisComplete(a.shortcode);
        } else if (!e?.response) {
          // Still offline — keep queued, leave analyzing placeholder alive
          remaining.push(a);
        } else {
          // HTTP error — discard, mark as failed so user can see it
          await this.markAnalysisComplete(a.shortcode);
          await this.markAsFailed(a.shortcode, a.url, a.title, a.thumbnail_url, a.content_type);
        }
      }
    }
    this.pendingAnalysesList = remaining;
    try {
      if (remaining.length === 0) await AsyncStorage.removeItem(PENDING_ANALYSES_KEY);
      else await AsyncStorage.setItem(PENDING_ANALYSES_KEY, JSON.stringify(remaining));
    } catch { /* best effort */ }
  }

  hasPendingAnalyses(): boolean {
    return this.pendingAnalysesList.length > 0;
  }

  // ─── Analyzing posts tracking ─────────────────────────────────────

  /**
   * Mark a post as currently being analyzed
   */
  async markAsAnalyzing(shortcode: string): Promise<void> {
    try {
      this.analyzingPosts.add(shortcode);
      await AsyncStorage.setItem(
        ANALYZING_POSTS_KEY, 
        JSON.stringify(Array.from(this.analyzingPosts))
      );
    } catch (error) {
      console.error('Error marking post as analyzing:', error);
    }
  }

  /**
   * Mark a post as analysis complete
   */
  async markAnalysisComplete(shortcode: string): Promise<void> {
    try {
      this.analyzingPosts.delete(shortcode);
      await AsyncStorage.setItem(
        ANALYZING_POSTS_KEY, 
        JSON.stringify(Array.from(this.analyzingPosts))
      );
    } catch (error) {
      console.error('Error marking analysis complete:', error);
    }
  }

  /**
   * Check if a post is currently being analyzed
   */
  isAnalyzing(shortcode: string): boolean {
    return this.analyzingPosts.has(shortcode);
  }

  /**
   * Get all analyzing posts
   */
  getAnalyzingPosts(): string[] {
    return Array.from(this.analyzingPosts);
  }

  // ─── Post storage — delegated to localDb ──────────────────────────

  /**
   * Save posts to local SQLite database.
   */
  async savePosts(posts: Post[]): Promise<void> {
    try {
      await localDb.upsertPosts(posts);
    } catch (error) {
      console.error('Error saving posts to local DB:', error);
    }
  }

  /**
   * Get all posts from local SQLite database (instant, no network).
   */
  async getCachedPosts(): Promise<Post[] | null> {
    try {
      const posts = await localDb.getAllPosts();
      return posts.length > 0 ? posts : null;
    } catch (error) {
      console.error('Error reading posts from local DB:', error);
      return null;
    }
  }

  /**
   * Check if local DB has data — always "valid" since it's persistent.
   */
  isCacheValid(): boolean {
    // Local DB is always valid — its data persists. Sync happens in background.
    return true;
  }

  /**
   * @deprecated Use isCacheValid() (sync) instead.
   */
  async isCacheValidAsync(): Promise<boolean> {
    return this.isCacheValid();
  }

  /**
   * Get posts from local DB (always returns data if DB has posts).
   */
  async getValidCachedPosts(): Promise<Post[] | null> {
    return this.getCachedPosts();
  }

  /**
   * Clear the local database.
   */
  async clearCache(): Promise<void> {
    try {
      await localDb.clearAll();
    } catch (error) {
      console.error('Error clearing local DB:', error);
    }
  }

  /**
   * Update a single post in local DB.
   */
  async updatePostInCache(updatedPost: Post): Promise<void> {
    try {
      await localDb.upsertPosts([updatedPost]);
    } catch (error) {
      console.error('Error updating post in local DB:', error);
    }
  }

  /**
   * Remove a post from local DB.
   */
  async removePostFromCache(shortcode: string): Promise<void> {
    try {
      await localDb.deletePost(shortcode);
    } catch (error) {
      console.error('Error removing post from local DB:', error);
    }
  }

  // ─── Failed posts ────────────────────────────────────────────────

  /** Returns failed posts from memory (instant) or AsyncStorage on first call. */
  async getFailedPosts(): Promise<FailedPost[]> {
    if (this.failedPostsCache !== null) return this.failedPostsCache;
    try {
      const stored = await AsyncStorage.getItem(FAILED_POSTS_KEY);
      this.failedPostsCache = stored ? (JSON.parse(stored) as FailedPost[]) : [];
      return this.failedPostsCache;
    } catch {
      return [];
    }
  }

  async markAsFailed(
    shortcode: string,
    url: string,
    title: string,
    thumbnail_url?: string,
    content_type?: string,
  ): Promise<void> {
    try {
      const existing = await this.getFailedPosts();
      const entry: FailedPost = { shortcode, url, title: title || url, thumbnail_url, content_type, failedAt: new Date().toISOString() };
      this.failedPostsCache = [entry, ...existing.filter(p => p.shortcode !== shortcode)];
      await AsyncStorage.setItem(FAILED_POSTS_KEY, JSON.stringify(this.failedPostsCache));
      await this.removePostFromCache(shortcode);
    } catch (error) {
      console.error('Error marking post as failed:', error);
    }
  }

  async removeFailed(shortcode: string): Promise<void> {
    try {
      const existing = await this.getFailedPosts();
      this.failedPostsCache = existing.filter(p => p.shortcode !== shortcode);
      await AsyncStorage.setItem(FAILED_POSTS_KEY, JSON.stringify(this.failedPostsCache));
    } catch (error) {
      console.error('Error removing failed post:', error);
    }
  }
}

export default new PostsCacheService();
