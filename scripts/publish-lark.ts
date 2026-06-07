import { readFileSync } from "node:fs";

const LARK_BASE_URL = process.env.LARK_BASE_URL || "https://open.feishu.cn";

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

function textElement(content: string) {
  return {
    text_run: {
      content,
      text_element_style: {},
    },
  };
}

function paragraph(content: string) {
  return {
    block_type: 2,
    text: {
      elements: [textElement(content)],
      style: {},
    },
  };
}

function heading(level: number, content: string) {
  const safeLevel = Math.min(Math.max(level, 1), 6);
  return {
    block_type: 2 + safeLevel,
    [`heading${safeLevel}`]: {
      elements: [textElement(content)],
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

function markdownToBlocks(markdown: string) {
  const blocks: any[] = [];
  let inCodeFence = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    if (!line.trim()) continue;

    if (line.trim().startsWith("```")) {
      inCodeFence = !inCodeFence;
      blocks.push(paragraph(line));
      continue;
    }

    if (!inCodeFence) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        blocks.push(heading(headingMatch[1].length, headingMatch[2].trim()));
        continue;
      }

      const bulletMatch = line.match(/^[-*]\s+(.+)$/);
      if (bulletMatch) {
        for (const part of splitLongLine(`• ${bulletMatch[1].trim()}`)) {
          blocks.push(paragraph(part));
        }
        continue;
      }

      const numberedMatch = line.match(/^(\d+)\.\s+(.+)$/);
      if (numberedMatch) {
        for (const part of splitLongLine(`${numberedMatch[1]}. ${numberedMatch[2].trim()}`)) {
          blocks.push(paragraph(part));
        }
        continue;
      }

      const quoteMatch = line.match(/^>\s?(.+)$/);
      if (quoteMatch) {
        for (const part of splitLongLine(`> ${quoteMatch[1].trim()}`)) {
          blocks.push(paragraph(part));
        }
        continue;
      }
    }

    for (const part of splitLongLine(line.trim())) {
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
  const url = `https://bai-zhou.feishu.cn/wiki/${nodeToken}`;

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
