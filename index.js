// package.json 안에 반드시 "type": "module" 추가
import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from 'axios'; 

// ---------------------------------
// 1. 환경 변수 및 설정
// ---------------------------------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TARGET_FORUM_IDS = ['1133385697454206986', '1429846734884044830'];
const EXCLUSION_TAG_ID = '1429845877484163082';

// ⭐ [수정됨] 모델 이름 정의
const FLASH_MODEL = "gemini-1.5-flash"; // 텍스트 전용
const PRO_MODEL = "gemini-2.5-pro";   // 이미지/링크/멘션 전용

// ---------------------------------
// 2. 클라이언트 및 API 초기화
// ---------------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------------------------------
// 3. Gemini API 호출 함수 (멀티모달)
// ---------------------------------

/**
 * 디스코드 URL에서 이미지를 가져와 Base64로 변환하는 헬퍼 함수
 */
async function fetchImageAsBase64(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data, 'binary').toString('base64');
    } catch (error) {
        console.error(`[Image Fetch Error] Failed to fetch image from ${url}:`, error.message);
        return null;
    }
}

/**
 * Gemini 모델을 호출하는 범용 함수 (텍스트 + 이미지)
 */
// ⭐ [수정됨] 기본 모델을 제거. 호출 시 명시적으로 모델을 받도록 함.
async function callGemini(prompt, images = [], modelName) { 
  try {
    const model = genAI.getGenerativeModel({ model: modelName });

    const parts = [ { text: prompt } ];

    for (const image of images) {
        const imageData = await fetchImageAsBase64(image.url);
        if (imageData) {
            parts.push({
                inlineData: {
                    mimeType: image.mimeType,
                    data: imageData
                }
            });
        }
    }

    const result = await model.generateContent({
      contents: [{ role: "user", parts: parts }], 
    });
    return result.response.text();
  } catch (err) {
    console.error(`[Gemini Error] ${modelName} 호출 실패:`, err.message);
    return null;
  }
}

// ---------------------------------
// 4. 봇 이벤트 핸들러
// ---------------------------------

client.once(Events.ClientReady, (c) => {
  console.log(`[READY] ${c.user.tag} 봇이 준비되었습니다!`);
});

/**
 * 기능 1 & 2: 새 글 작성 시 자동 응답 (이미지/링크 감지)
 */
client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
  if (!newlyCreated || !TARGET_FORUM_IDS.includes(thread.parentId)) return;
  
  try {
    console.log(`[Thread Create] 새 글 감지: "${thread.name}"`);

    if (thread.appliedTags.includes(EXCLUSION_TAG_ID)) {
      console.log(`[Feature 2] 예외 태그 감지 → 자동응답 생략`);
      return;
    }

    // 10008 오류 (Unknown Message) 방지를 위해 3초 대기
    await new Promise(resolve => setTimeout(resolve, 3000)); 

    const starterMessage = await thread.fetchStarterMessage();

    if (!starterMessage) {
        console.log(`[Feature 1] Starter message를 찾을 수 없어 응답을 생략합니다. (Thread ID: ${thread.id})`);
        return;
    }

    const postContent = starterMessage?.content || "(내용 없음)";
    const postTitle = thread.name;

    // 이미지 감지
    const imageAttachments = starterMessage.attachments
        .filter(att => att.contentType?.startsWith('image/'))
        .map(att => ({ mimeType: att.contentType, url: att.url }));

    // ⭐ [수정됨] 링크(URL) 감지
    const linkRegex = /(https?:\/\/[^\s]+)/;
    const containsLink = linkRegex.test(postContent);

    // ⭐ [수정됨] 모델 선택 로직
    let modelToUse = FLASH_MODEL; // 기본은 Flash
    let imagePromptPart = "";

    if (imageAttachments.length > 0 || containsLink) {
        modelToUse = PRO_MODEL; // 이미지나 링크가 있으면 Pro로 변경
        
        if (imageAttachments.length > 0) {
            console.log(`[Feature 1] ${imageAttachments.length}개의 이미지 감지. Pro 모델로 전환합니다.`);
            imagePromptPart = "\n(참고: 글에 이미지도 올렸노. 그것도 봐라.)";
        } else if (containsLink) {
            console.log(`[Feature 1] 링크 감지. Pro 모델로 전환합니다.`);
            imagePromptPart = "\n(참고: 글에 링크가 포함되어 있노. 링크 내용도 참고해라.)";
        }
    } else {
        console.log(`[Feature 1] 텍스트 전용 글. Flash 모델을 사용합니다.`);
    }

    // (프롬프트는 디시말투 유지)
    const flashPrompt = `
    당신은 디시인사이드 갤러리 유저(고닉)입니다. ('디시말투' 사용)
    아래 게시글에 대해, 디시말투를 사용한 첫 번째 댓글을 생성해주세요.

    [게시글 제목]: "${postTitle}"
    [게시글 내용]: "${postContent}"
    ${imagePromptPart}

    [댓글 생성 가이드라인]
    1. 무조건 반말로, 짧고 직설적으로 말해야 합니다.
    2. 문장 끝을 '~노', '~고', '~다', '~냐', '~함', '~임' 등으로 끝맺으세요.
    3. 특유의 냉소적이거나 툭툭 던지는 말투를 사용하세요. (예: 'ㅋㅋ', 'ㅇㅇ', '개추')
    4. (중요) "네, 알겠습니다" 같은 깍듯한 서문 없이, 댓글 내용만 바로 출력해야 합니다.
    `;

    await thread.sendTyping();
    // ⭐ [수정됨] 선택된 모델(modelToUse)로 API 호출
    const flashResponse = await callGemini(flashPrompt, imageAttachments, modelToUse); 

    if (flashResponse) {
      await thread.send(flashResponse);
      console.log(`[Feature 1] 자동 응답 완료.`);
    } else {
      console.log(`[Feature 1] API 호출 실패로 자동 응답 미전송.`);
    }
  } catch (error) {
    console.error("[ThreadCreate Error] 자동 응답 처리 중 오류:", error);
  }
});

/**
 * 기능 3: 멘션(@봇)으로 질문 시 답변 (항상 Pro 모델)
 */
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.mentions.has(client.user.id)) return;
    if (!message.channel.isThread()) return;
    const threadChannel = message.channel;
    if (!TARGET_FORUM_IDS.includes(threadChannel.parentId)) return;

    try {
        console.log(`[Feature 3] 멘션 감지 (In: ${threadChannel.name}) - Pro 모델 사용`);
        await message.channel.sendTyping();

        const starterMessage = await threadChannel.fetchStarterMessage();
        
        if (!starterMessage) {
            console.log(`[Feature 3] Starter message를 찾을 수 없어 응답을 생략합니다. (Thread ID: ${threadChannel.id})`);
            return;
        }

        const postContext = starterMessage?.content || "(내용 없음)";
        const postTitle = threadChannel.name;

        const contextImageAttachments = starterMessage.attachments
            .filter(att => att.contentType?.startsWith('image/'))
            .map(att => ({ mimeType: att.contentType, url: att.url }));

        if (contextImageAttachments.length > 0) {
            console.log(`[Feature 3] 원본 글의 이미지 ${contextImageAttachments.length}개를 문맥에 포함합니다.`);
        }

        const userQuestion = message.content.replace(/<@!?\d+>/g, '').trim();
        if (!userQuestion) {
             await message.reply("왜 불렀노? 질문이나 해라.");
             return;
        }

        const contextImagePromptPart = contextImageAttachments.length > 0 ? "\n(참고: 원본 글에 이미지도 있음. 그것도 문맥으로 봐라.)" : "";

        // (프롬프트는 디시말투 유지)
        const proPrompt = `
            당신은 '정원봇'입니다. 디시인사이드 갤러리 유저(고닉) 말투('디시말투')를 사용합니다.
            사용자가 원본 게시글에 대해 멘션으로 질문했습니다.

            [문맥: 원본 게시글]
            제목: "${postTitle}"
            내용: "${postContext}"
            ${contextImagePromptPart}
            
            ---
            
            [사용자의 질문]
            "${userQuestion}"
            
            ---
            
            [답변 가이드라인]
            1. 위 [원본 게시글] 내용을 바탕으로 사용자의 [질문]에 대해 디시말투로 답변해주세요.
            2. 무조건 반말로, 짧고 직설적으로 말해야 합니다.
            3. (중요) "네, 알겠습니다" 같은 깍듯한 서문 없이, 답변 내용만 바로 출력해야 합니다.
        `;

        // ⭐ [수정됨] 멘션 답변은 항상 PRO_MODEL 사용
        const proResponse = await callGemini(proPrompt, contextImageAttachments, PRO_MODEL);

        if (proResponse) {
            await message.reply(proResponse);
            console.log(`[Feature 3] Pro 모델 답변 완료.`);
        } else {
            await message.reply('ㅋㅋ 아 오류났노. 나중에 다시 물어봐라.');
            console.log(`[Feature 3] API 호출 실패로 멘션 답변 미전송.`);
        }

    } catch (error) {
        console.error('[MessageCreate Error] 멘션 답변 처리 중 오류 발생:', error);
        await message.reply('ㅋㅋ 아 오류났노. 나중에 다시 물어봐라.');
    }
});


// ---------------------------------
// 5. 봇 로그인
// ---------------------------------
client.login(DISCORD_BOT_TOKEN);