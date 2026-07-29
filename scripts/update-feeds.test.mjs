import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeed,
  feedGeneratedAt,
  fetchProfilePosts,
  isFeedFresh,
  normalizePost,
  postTitle,
  STALE_AFTER_MS,
} from "./update-feeds.mjs";

const journalist = {
  username: "fabriziorom",
  name: "Fabrizio Romano",
  profileUrl: "https://www.threads.com/@fabriziorom",
};

test("freshness comes from the timestamp embedded in the RSS feed", () => {
  const now = Date.parse("2026-07-29T20:10:00.000Z");
  const xml = "<nova:generatedAt>2026-07-29T20:05:00.000Z</nova:generatedAt>";
  assert.equal(feedGeneratedAt(xml), Date.parse("2026-07-29T20:05:00.000Z"));
  assert.equal(isFeedFresh(xml, now), true);
  assert.equal(isFeedFresh(xml, now + STALE_AFTER_MS), false);
});

test("normalizes a public profile post and produces a useful title", () => {
  const post = normalizePost(
    {
      id: "123",
      username: "fabriziorom",
      permalink: "https://www.threads.com/@fabriziorom/post/123",
      text: "Exclusive: a major transfer agreement is now complete. More details soon.",
      timestamp: "2026-07-29T20:00:00+0000",
      media_url: "https://cdn.example.com/photo.jpg",
    },
    journalist,
  );
  assert.equal(post.title, "Exclusive: a major transfer agreement is now complete.");
  assert.equal(post.imageUrl, "https://cdn.example.com/photo.jpg");
  assert.equal(postTitle("", "Fallback"), "Fallback");
});

test("calls the official public profile endpoint with an OAuth bearer token", async () => {
  let requestedUrl;
  let requestedOptions;
  const posts = await fetchProfilePosts(journalist, "secret-token", async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "123",
            permalink: "https://www.threads.com/@fabriziorom/post/123",
            username: "fabriziorom",
            text: "Latest football update",
            timestamp: "2026-07-29T20:00:00+0000",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  assert.equal(requestedUrl.origin, "https://graph.threads.net");
  assert.equal(requestedUrl.pathname, "/profile_posts");
  assert.equal(requestedUrl.searchParams.get("username"), "fabriziorom");
  assert.equal(requestedOptions.headers.Authorization, "Bearer secret-token");
  assert.equal(posts.length, 1);
});

test("RSS includes explicit ten-minute freshness metadata", () => {
  const generatedAt = new Date("2026-07-29T20:00:00.000Z");
  const xml = buildFeed({
    title: "Football Journalists on Threads",
    description: "Latest posts",
    siteUrl: "https://github.com/fahimc/threads-football-rss",
    selfUrl:
      "https://raw.githubusercontent.com/fahimc/threads-football-rss/main/feeds/football.xml",
    generatedAt,
    posts: [
      {
        id: "123",
        username: "fabriziorom",
        title: "Transfer update",
        text: "Transfer update & details",
        permalink: "https://www.threads.com/@fabriziorom/post/123",
        timestamp: generatedAt.toISOString(),
      },
    ],
  });
  assert.match(xml, /<ttl>10<\/ttl>/);
  assert.match(xml, /<nova:generatedAt>2026-07-29T20:00:00.000Z<\/nova:generatedAt>/);
  assert.match(xml, /<dc:creator>@fabriziorom<\/dc:creator>/);
  assert.match(xml, /<!\[CDATA\[Transfer update & details\]\]>/);
});
