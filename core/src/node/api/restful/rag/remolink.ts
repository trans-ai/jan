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

  const headers: Record<string, any> = {
    'Content-Type': 'application/json',
  }

  const apiUrl = `${agentUrl}`
  const param = JSON.stringify({
    keyword: `${keyword}`
  })
  
  const options = { method: 'POST', headers: headers, body: param }
  const data = await fetch(`${apiUrl}`, options).then((res) => { return res.json() }).then((value) => { return value })
  //console.log(`result from rag server: ${JSON.stringify(data)}`)

  const msgId = ulid()
  const createdAt = Date.now()

  const choices = {
    choices: [
      {
        message: {
          content: [
            {
              type: 'text',
              keyword: `${data?.content?.keyword}`,
              content: `${data?.content?.text}`
            }
          ]
        },
        created: createdAt,
        id: msgId,
        model: "_",
        object: "chat.completion.message"
      }
    ]
  }

  return {
    stream: Readable.from([`data: ${JSON.stringify(choices)}`, '\n', '\n'], { encoding: "utf-8", read: (size) => { } }),
    prompt: {
      "content": `You are very helpfull assistant.
${keyword}에 대해, 다음 문장과 링크 및 이미지를 참고하여 사용자의 질문에 대답해줘. 참고 이미지와 링크도 제시해줘.

>> 문장:
${data?.content?.text}

>> 링크:
${JSON.stringify(data?.content?.links)}

>> 이미지:
${JSON.stringify(data?.content?.images)}

>> IMPORTANT!! Output format should be in a Bullet point list! and add line space at end of paragraph.
>> IMPORTANT!! image tag format should be in Markdown format.\n\n
      `,
      "role": "system"
    }
  }
}

// async function* generateData() {
//   for (let i = 0; i < 1000; i++) {
//       await new Promise(resolve => setTimeout(resolve, 1000));
//       yield `data chunk ${i}\n`;
//   }
// }
