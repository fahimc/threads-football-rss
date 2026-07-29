import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const STALE_AFTER_MS = 10 * 60_000;
export const THREADS_API_HOST = "https://graph.threads.net";
export const THREAD_FIELDS = [
  "id",
  "media_type",
  "media_url",
  "permalink",
  "username",
  "text",
  "timestamp",
  "shortcode",
  "thumbnail_url",
  "children",
  "is_quote_post",
  "alt_text",
  "link_attachment_url",
  "profile_picture_url",
].join(",");

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const feedsDirectory = path.join(rootDirectory, "feeds");
const aggregateFeedPath = path.join(feedsDirectory, "football.xml");
const dataPath = path.join(feedsDirectory, "data.json");
const statusPath = path.join(feedsDirectory, "status.json");
const configPath = path.join(rootDirectory, "config", "journalists.json");

export function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function cdata(value) {
  return `<![CDATA[${String(value ?? "").replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

export function feedGeneratedAt(xml) {
  const novaTimestamp = xml.match(/<nova:generatedAt>([^<]+)<\/nova:generatedAt>/i)?.[1];
  const lastBuildDate = xml.match(/<lastBuildDate>([^<]+)<\/lastBuildDate>/i)?.[1];
  const timestamp = Date.parse(novaTimestamp || lastBuildDate || "");
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function isFeedFresh(xml, now = Date.now()) {
  const generatedAt = feedGeneratedAt(xml);
  return generatedAt !== undefined && now - generatedAt < STALE_AFTER_MS;
}

function cleanText(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim();
}

export function postTitle(text, fallback) {
  const clean = cleanText(text).replaceAll(/https?:\/\/\S+/g, "").trim();
  if (!clean) return fallback;
  const sentence = (clean.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? clean).trim();
  if (sentence.length <= 110) return sentence;
  const candidate = sentence.slice(0, 109);
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary > 70 ? boundary : 109).trim()}…`;
}

function firstMediaUrl(post) {
  if (post.media_url) return post.media_url;
  if (post.thumbnail_url) return post.thumbnail_url;
  const firstChild = post.children?.data?.find(
    (child) => child?.media_url || child?.thumbnail_url,
  );
  return firstChild?.media_url ?? firstChild?.thumbnail_url;
}

export function normalizePost(post, journalist) {
  if (!post?.id || !post?.permalink || !post?.timestamp) return undefined;
  const text = cleanText(post.text || post.alt_text);
  return {
    id: String(post.id),
    username: cleanText(post.username) || journalist.username,
    journalistName: journalist.name,
    profileUrl: journalist.profileUrl,
    permalink: String(post.permalink),
    text,
    title: postTitle(text, `${journalist.name} posted on Threads`),
    timestamp: new Date(post.timestamp).toISOString(),
    imageUrl: firstMediaUrl(post),
    mediaType: cleanText(post.media_type),
    isQuotePost: Boolean(post.is_quote_post),
  };
}

export async function fetchProfilePosts(journalist, accessToken, fetchImpl = fetch) {
  const endpoint = new URL("/profile_posts", THREADS_API_HOST);
  endpoint.searchParams.set("username", journalist.username);
  endpoint.searchParams.set("fields", THREAD_FIELDS);
  endpoint.searchParams.set("limit", "25");

  const response = await fetchImpl(endpoint, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload?.error?.message || `Threads API returned HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!Array.isArray(payload.data)) {
    throw new Error("Threads API response did not contain a data array.");
  }
  return payload.data
    .map((post) => normalizePost(post, journalist))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
}

function itemXml(post) {
  const media = post.imageUrl
    ? `\n      <media:content url="${xmlEscape(post.imageUrl)}" medium="image"/>`
    : "";
  return `    <item>
      <title>${xmlEscape(post.title)}</title>
      <link>${xmlEscape(post.permalink)}</link>
      <guid isPermaLink="false">threads:${xmlEscape(post.id)}</guid>
      <description>${cdata(post.text)}</description>
      <content:encoded>${cdata(post.text)}</content:encoded>
      <dc:creator>@${xmlEscape(post.username)}</dc:creator>
      <category>Sport</category>
      <category>Football</category>
      <category>Threads</category>
      <pubDate>${new Date(post.timestamp).toUTCString()}</pubDate>${media}
    </item>`;
}

export function buildFeed({ title, description, siteUrl, selfUrl, posts, generatedAt }) {
  const items = posts.map(itemXml).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:media="http://search.yahoo.com/mrss/"
  xmlns:nova="https://github.com/fahimc/threads-football-rss/ns">
  <channel>
    <title>${xmlEscape(title)}</title>
    <link>${xmlEscape(siteUrl)}</link>
    <description>${xmlEscape(description)}</description>
    <language>en-gb</language>
    <lastBuildDate>${generatedAt.toUTCString()}</lastBuildDate>
    <ttl>10</ttl>
    <atom:link href="${xmlEscape(selfUrl)}" rel="self" type="application/rss+xml"/>
    <nova:generatedAt>${generatedAt.toISOString()}</nova:generatedAt>
    <nova:staleAfterMinutes>10</nova:staleAfterMinutes>
${items}
  </channel>
</rss>
`;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function updateFeeds({
  now = new Date(),
  force = false,
  accessToken = process.env.THREADS_ACCESS_TOKEN,
  fetchImpl = fetch,
} = {}) {
  const existingAggregate = await readFile(aggregateFeedPath, "utf8").catch(() => "");
  if (!force && isFeedFresh(existingAggregate, now.getTime())) {
    return { updated: false, reason: "fresh", generatedAt: feedGeneratedAt(existingAggregate) };
  }
  if (!accessToken) {
    throw new Error(
      "THREADS_ACCESS_TOKEN is required. Add it as an Actions secret with threads_basic and threads_profile_discovery access.",
    );
  }

  const journalists = (await readJson(configPath, [])).filter((journalist) => journalist.enabled);
  const existingData = await readJson(dataPath, {
    version: 1,
    updatedAt: now.toISOString(),
    journalists: {},
  });
  const settled = await Promise.allSettled(
    journalists.map(async (journalist) => ({
      journalist,
      posts: await fetchProfilePosts(journalist, accessToken, fetchImpl),
    })),
  );

  const failures = [];
  let successful = 0;
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const journalist = journalists[index];
    if (result.status === "fulfilled") {
      successful += 1;
      existingData.journalists[journalist.username] = {
        ...journalist,
        fetchedAt: now.toISOString(),
        posts: result.value.posts,
      };
    } else {
      failures.push({
        username: journalist.username,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
  if (!successful) {
    throw new Error(`No Threads profiles refreshed: ${failures.map((item) => item.message).join("; ")}`);
  }

  existingData.version = 1;
  existingData.updatedAt = now.toISOString();
  const allPosts = Object.values(existingData.journalists)
    .flatMap((entry) => entry.posts ?? [])
    .filter((post, index, posts) => posts.findIndex((item) => item.permalink === post.permalink) === index)
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, 200);

  for (const journalist of journalists) {
    const cached = existingData.journalists[journalist.username];
    if (!cached?.posts) continue;
    await writeFile(
      path.join(feedsDirectory, `${journalist.username}.xml`),
      buildFeed({
        title: `${journalist.name} on Threads`,
        description: `Latest public Threads posts by football journalist ${journalist.name}.`,
        siteUrl: journalist.profileUrl,
        selfUrl: `https://raw.githubusercontent.com/fahimc/threads-football-rss/main/feeds/${journalist.username}.xml`,
        posts: cached.posts,
        generatedAt: now,
      }),
      "utf8",
    );
  }

  await writeFile(
    aggregateFeedPath,
    buildFeed({
      title: "Football Journalists on Threads",
      description: "Latest public Threads posts from curated football journalists.",
      siteUrl: "https://github.com/fahimc/threads-football-rss",
      selfUrl:
        "https://raw.githubusercontent.com/fahimc/threads-football-rss/main/feeds/football.xml",
      posts: allPosts,
      generatedAt: now,
    }),
    "utf8",
  );
  await writeFile(dataPath, `${JSON.stringify(existingData, null, 2)}\n`, "utf8");
  await writeFile(
    statusPath,
    `${JSON.stringify(
      {
        generatedAt: now.toISOString(),
        staleAfterMinutes: 10,
        source: "Meta Threads API",
        attempted: journalists.length,
        successful,
        failed: failures,
        ready: allPosts.length > 0,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { updated: true, successful, failures, posts: allPosts.length };
}

async function main() {
  const force = process.env.FORCE_REFRESH === "true";
  const result = await updateFeeds({ force });
  console.log(JSON.stringify(result));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
