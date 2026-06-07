import { readFileSync } from "node:fs";

const LARK_BASE_URL = process.env.LARK_BASE_URL || "https://open.feishu.cn";
const LARK_WIKI_BASE_URL = process.env.LARK_WIKI_BASE_URL || "https://bai-zhou.feishu.cn";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

async function larkFetch<T>(
  path: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");

  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const res = await fetch(`${LARK_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || json.code !== 0) {
    throw new Error(
      `Lark API failed: ${path}\nHTTP ${res.status}\n${JSON.stringify(json, null, 2)}`,
    );
  }

  return json as T;
}

async function getTenantAccessToken(): Promise<string> {
  const appId = required("LARK_APP_ID");
  const appSecret = required("LARK_APP_SECRET");

  const json = await larkFetch<{ tenant_access_token: string }>(
    "/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret,
      }),
    },
  );

  return json.tenant_access_token;
}

function todayInShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function cleanInline(input: string): string {
  return input
    .replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .trim();
}

function textElement(content: string, url?: string) {
  return {
    text_run: {
      content: cleanInline(content),
      text_element_style: url ? { link: { url } } : {},
    },
  };
}

function inlineElements(content: string) {
  const elements: any[] = [];
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(content)) !== null) {
    const before = content.slice(cursor, match.index);
    if (cleanInline(before)) {
      elements.push(textElement(before));
    }

    elements.push(textElement(match[1], match[2]));
    cursor = match.index + match[0].length;
  }

  const rest = content.slice(cursor);
  if (cleanInline(rest)) {
    elements.push(textElement(rest));
  }

  return elements.length > 0 ? elements : [textElement(content)];
}

function paragraph(content: string) {
  return {
    block_type: 2,
    text: {
      elements: inlineElements(content),
      style: {},
    },
  };
}

function heading(level: number, content: string) {
  const safeLevel = Math.min(Math.max(level, 1), 6);

  return {
    block_type: 2 + safeLevel,
    [`heading${safeLevel}`]: {
      elements: inlineElements(content),
      style: {},
    },
  };
}

function splitLongLine(line: string, max = 900): string[] {
  if (line.length <= max) return [line];

  const parts: string[] = [];
  for (let i = 0; i < line.length; i += max) {
    parts.push(line.slice(i, i + max));
  }
  return parts;
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cleanInline(cell.trim()));
}

function isTableSeparator(line: string): boolean {
  return /^\|?[\s:|-]+\|?$/.test(line.trim());
}

function markdownToBlocks(markdown: string) {
  const blocks: any[] = [];
  const lines = markdown.split(/\r?\n/);

  let inCodeFence = false;
  let inMermaid = false;
  let inDetails = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (trimmed === "<details>") {
      inDetails = true;
      continue;
    }

    if (trimmed === "</details>") {
      inDetails = false;
      continue;
    }

    if (inDetails) continue;

    if (/^```mermaid/i.test(trimmed)) {
      inMermaid = true;
      continue;
    }

    if (inMermaid) {
      if (trimmed === "```") {
        inMermaid = false;
        continue;
      }

      const category = trimmed.match(/^"(.+)"\s*:\s*(\d+)$/);
      if (category) {
        blocks.push(paragraph(`• ${category[1]}：${category[2]} 篇`));
      }

      continue;
    }

    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) {
      for (const part of splitLongLine(line)) {
        blocks.push(paragraph(part));
      }
      continue;
    }

    if (/^---+$/.test(trimmed)) continue;

    if (
      trimmed.startsWith("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = parseTableRow(trimmed);
      i += 2;

      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const values = parseTableRow(lines[i]);
        const summary = headers
          .map((header, index) => `${header}：${values[index] || "-"}`)
          .join(" · ");

        blocks.push(paragraph(summary));
        i++;
      }

      i--;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push(heading(headingMatch[1].length, headingMatch[2]));
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      blocks.push(paragraph(`• ${bulletMatch[1]}`));
      continue;
    }

    const numberedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (numberedMatch) {
      blocks.push(paragraph(`${numberedMatch[1]}. ${numberedMatch[2]}`));
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s?(.+)$/);
    if (quoteMatch) {
      for (const part of splitLongLine(quoteMatch[1])) {
        blocks.push(paragraph(`摘要：${part}`));
      }
      continue;
    }

    for (const part of splitLongLine(trimmed)) {
      blocks.push(paragraph(part));
    }
  }

  if (blocks.length === 0) {
    blocks.push(paragraph("今日暂无可发布内容。"));
  }

  return blocks;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

async function createWikiDoc(token: string, title: string) {
  const spaceId = required("LARK_SPACE_ID");

  const json = await larkFetch<any>(
    `/open-apis/wiki/v2/spaces/${spaceId}/nodes`,
    {
      method: "POST",
      token,
      body: JSON.stringify({
        node_type: "origin",
        obj_type: "docx",
        title,
      }),
    },
  );

  const node = json.data?.node || json.node || json.data;
  const documentId = node.obj_token;
  const nodeToken = node.node_token;
  const url = `${LARK_WIKI_BASE_URL}/wiki/${nodeToken}`;

  if (!documentId || !nodeToken) {
    throw new Error(`Unexpected wiki create response: ${JSON.stringify(json, null, 2)}`);
  }

  return { documentId, nodeToken, url };
}

async function appendBlocks(token: string, documentId: string, blocks: any[]) {
  for (const batch of chunks(blocks, 40)) {
    await larkFetch<any>(
      `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children?document_revision_id=-1`,
      {
        method: "POST",
        token,
        body: JSON.stringify({
          index: -1,
          children: batch,
        }),
      },
    );
  }
}

async function notifyGroup(token: string, title: string, url: string) {
  const chatId = required("LARK_CHAT_ID");

  await larkFetch<any>(
    "/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      method: "POST",
      token,
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({
          text: `AI 日报已生成：${title}\n${url}`,
        }),
      }),
    },
  );
}

async function main() {
  const digestFile = process.env.DIGEST_FILE || "digest.md";
  const reportDate = process.env.REPORT_DATE || todayInShanghai();
  const title = `${reportDate} AI 日报`;

  const markdown = readFileSync(digestFile, "utf8");
  const token = await getTenantAccessToken();

  const { documentId, url } = await createWikiDoc(token, title);
  const blocks = markdownToBlocks(markdown);

  await appendBlocks(token, documentId, blocks);
  await notifyGroup(token, title, url);

  console.log(`Published ${title}`);
  console.log(url);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
