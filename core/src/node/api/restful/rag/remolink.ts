import fetch from 'node-fetch'
import { ulid } from 'ulidx';
import { Readable } from 'stream'

//MARK: sooskim - extend to external agent
export const chatCompletions0 = async (body: any) => {
  var keyword = null
  var agentUrl = null

  const inputAgent = body?.agent
  const inputMessage = body?.messages

  if (inputMessage !== undefined && inputMessage !== null && inputMessage.length > 0) {
    keyword = inputMessage[0].content?.replace("#", "").trim()
  }
  if (inputAgent !== undefined && inputAgent !== null) {
    agentUrl = inputAgent.url?.trim()
  }

  if (!(agentUrl !== undefined && agentUrl !== null && agentUrl.length > 7)) {
    return {
      stream: Readable.from([], { encoding: "utf-8", read: (size) => { } }),
      prompt: {
        system: null
      }
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'Connection': 'close',
    'Access-Control-Allow-Origin': '*',
  }

  const apiUrl = `${agentUrl}`
  const param = JSON.stringify({
    keyword: `${keyword}`
  })
  
  const options = { method: 'POST', headers: headers, body: param }
  const data = await fetch(`${apiUrl}`, options).then((res) => { return res.json() }).catch((reason) => { })

  console.log(`RAG result from agent: ${JSON.stringify(data?.text)}`)

  const msgId = ulid()
  const createdAt = Date.now()

  const choices = {
    choices: [
      {
        message: {
          content: [
            {
              type: 'text',
              keyword: `${data?.keyword}`,
              content: `${data?.text}`
            }
          ]
        },
      },
    ],
    created: createdAt,
    id: msgId,
    model: "_",
    object: "chat.completion.message"
  }

  return {
    data: data,
    stream: Readable.from([`data: ${JSON.stringify(choices)}`, '\n', '\n'], { encoding: "utf-8", read: (size) => { } }),
    prompt: {
      "content": `You are very helpfull assistant. ${keyword}에 대해, 다음 문장을 참고하여 사용자의 질문에 대답해줘.

${data?.text}
`,
      "role": "system"
    }
  }
}

export const chatCompletionsMeta = async (meta: any) => {
  const msgId = ulid()
  const createdAt = Date.now()

  const choices = {
    choices: [
      {
        message: {
          content: [
            {
              type: 'image',
              content: meta?.images
            }
          ]
        },
      },
    ],
    created: createdAt,
    id: msgId,
    model: "_",
    object: "chat.completion.message"
  }

  const eventString = JSON.stringify(choices)
  //console.log(`WILL BE STREAM: ${eventString}`)

  return {
    stream: Readable.from([`data: ${eventString}`, '\n', '\n'], { encoding: "utf-8", read: (size) => { } }),
  }
}

// async function* generateData() {
//   for (let i = 0; i < 1000; i++) {
//       await new Promise(resolve => setTimeout(resolve, 1000));
//       yield `data chunk ${i}\n`;
//   }
// }
