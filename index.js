import puppeteer from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import useragent from "puppeteer-extra-plugin-anonymize-ua";
import { createParser } from 'eventsource-parser';
import express from "express";
import qs from "querystring";
import StableHorde from "@zeldafan0225/stable_horde";
import expressWs from "express-ws";
// import { executablePath } from "puppeteer";
import axios from "axios";
import { Text2Speech } from "better-node-gtts";

puppeteer.use(stealth());
puppeteer.use(useragent());

const app = express();
expressWs(app);
app.use(express.json({ limit: "50mb" }));
app.get("/", (req, res) => res.status(200).send("OK"));

let options = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
};
if (process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD)
    options.executablePath = '/usr/bin/chromium-browser';
if (process.env.PUPPETEER_HEADFUL)
    options.headless = false;
if (process.env.PUPPETEER_USERDATADIR)
    options.userDataDir = process.env.PUPPETEER_USERDATADIR;
if (process.env.PUPPETEER_PROXY)
    options.args.push(`--proxy-server=${process.env.PUPPETEER_PROXY}`);

let browser = await puppeteer.launch({ ...options });
console.log("BROWSER: Process launched");

const YOU_API_YOU_BASE_URL = "https://you.com/api/streamingSearch";
const YOU_BASE_URL = "https://you.com/chat";

const traceIdMap = new Map();
const fetchQueryTraceToken = async (traceId) => {
    const existingQueryTraceId = traceIdMap.get(traceId);
    if (existingQueryTraceId) return existingQueryTraceId;
    else {
        return new Promise(async (resolve, reject) => {
            const page = await browser.newPage();
            await page.setRequestInterception(true);

            page.on("request", async (interceptedRequest) => {
                if (interceptedRequest.url().startsWith(YOU_API_YOU_BASE_URL)) {
                    const traceToken = new URL(interceptedRequest.url()).searchParams.get("queryTraceId");
                    traceIdMap.set(traceId, traceToken);
                    resolve(traceToken);
                    await page.close();
                }
                else await interceptedRequest.continue();
            });

            page.on("close", () => {
                reject("No trace token found")
            });
            await page.goto(YOU_BASE_URL);

        })
    }
}

app.all("/chat", async (req, res) => {
    const query = req.body?.q ?? req.query.q;
    const stream = req.body?.stream ?? req.query.stream ?? false;
    const traceId = req.body?.traceId ?? req.query.traceId ?? null;
    const metadata = req.body?.metadata ?? req.query.metadata ?? null;
    if (!query || !traceId) return res.status(404).send({ status: false, message: "Invalid request payload" });

    const traceToken = await fetchQueryTraceToken(traceId).catch((e) => {
        console.log(e)
        return null;
    });
    if (!traceToken) return res.status(404).send({ status: false, message: "Unable to fetch query trace token" });

    const vars = {
        page: 1,
        count: 10,
        safeSearch: "Moderate",
        onShoppingPage: false,
        responseFilter: ["WebPages", "Translations", "TimeZone", "Computation", "RelatedSearches"],
        domain: "youchat",
        q: query,
        queryTraceId: traceToken,
        chatId: traceToken
    };

    const reqURL = `${YOU_API_YOU_BASE_URL}?${qs.stringify(vars)}`;

    try {
        const page = await browser.newPage();
        await page.goto(reqURL, { referer: "https://you.com" });

        const pageContent = await page.evaluate(() => document.body.textContent);

        let data = {
            error: false,
            content: "",
            intents: null,
            trace: {
                id: traceId,
                token: traceToken
            }
        };

        let contentStream = [];
        const parser = createParser((stream) => {
            if (stream.type === 'event') {
                if (stream.event === "youChatToken") {
                    const streamData = JSON.parse(stream.data);
                    contentStream.push(streamData["youChatToken"]);
                }
                if (stream.event === "intents") {
                    const streamData = JSON.parse(stream.data);
                    data.intents = streamData?.intents ?? [];
                }
                if (stream.event === "error") {
                    data.error = true;
                }
            }
        });
        parser.feed(pageContent);
        parser.reset();

        await page.close();

        if (metadata) data.metaData = vars;
        res.send({
            status: !data.error, data: {
                ...data,
                content: contentStream.join("").trimStart(),
                stream: stream ? contentStream : null
            }
        });
    } catch (error) {
        res.status(404).send({ status: false, message: "An unexpected error ocurred" });
        console.log(error);
        await browser.close().catch((e) => console.log(e));
        browser = await puppeteer.launch(options);
    }

});

const artClient = new StableHorde({
    default_token: "7AyFLyrYao9s1FCPH7nj1A"
});


app.all("/art/generate", async (req, res) => {
    const prompt = req.body?.prompt ?? req.query.prompt;
    if (!prompt) return res.status(404).send({ status: false, message: "Invalid request payload" });

    const data = await artClient.postAsyncGenerate({
        prompt,
        params: {
            post_processing: [
                "GFPGAN",
                "RealESRGAN_x4plus"
            ]
        },
        ...req.body
    });

    res.send({
        status: data.id ? true : false, data: {
            ...data,
            ws: `art/ws/${data.id}`
        }
    });
});

app.get("/art/show/:id", async (req, res) => {
    const { id } = req.params;
    const data = await artClient.getGenerationCheck(id, { force: true }).catch(() => null);
    if (data) res.send({ status: true, data })
    else res.send({ status: false, message: "No found" })
});

app.ws(`/art/ws/:id`, async (ws, req) => {
    const { id } = req.params;
    const check = await artClient.getGenerationCheck(id).catch(() => null);
    if (!check) return ws.close();
    send(ws);
    const checkStatus = setInterval(() => send(ws), 1000 * 3);
    async function send(ws) {
        let status = await artClient.getGenerationCheck(id, { force: true }).catch(() => undefined);
        if (status?.done) {
            status = await artClient.getGenerationStatus(id, { force: true }).catch(() => undefined);
        }
        ws.send(JSON.stringify({ status: true, data: status }));
        if (status?.done) {
            clearInterval(checkStatus);
            ws.close();
        }
    }
    ws.on("close", () => {
        if (checkStatus) clearInterval(checkStatus);
    })
});

app.get("/art/models", async (req, res) => {
    const data = await artClient.getModels({ force: true });
    res.send({ status: true, data })
});

const TIYARO_BASE_URL = "https://console.tiyaro.ai/explore/openai-whisper-large?q=whisper";
const TIYARO_API_URL = "https://api.tiyaro.ai";
const TIYARO_API_PATH = "/v1/ent/openai/1/openai/whisper-large?serviceTier=gpuflex";

let tiyroHeader = null;
async function fetchTiyaroHeader() {
    if (tiyroHeader) return tiyroHeader;
    const page = await browser.newPage();
    await page.setRequestInterception(true);

    return new Promise(async (resolve, reject) => {
        page.on("request", async (interceptedRequest) => {
            const url = interceptedRequest.url();
            const method = interceptedRequest.method();

            if (url.startsWith(TIYARO_API_URL) && url.includes("whisper-large") && method == "POST") {
                const headers = interceptedRequest.headers();
                tiyroHeader = headers;
                resolve(headers);
                await page.close();
            }
            else interceptedRequest.continue();
        });

        page.on("close", () => {
            reject("No headers found")
        });
        await page.goto(TIYARO_BASE_URL);
    });
}

fetchTiyaroHeader().catch(() => { });
app.post("/stt/ext", async (req, res) => {
    const { audio } = req.body;
    if (!audio) return res.send({ status: false, message: "Invalid body" });
    try {
        const headers = await fetchTiyaroHeader();
        const get = await axios.post(TIYARO_API_URL + TIYARO_API_PATH, {
            input: {
                no_speech_threshold: 0.6,
                patience: 1,
                suppress_tokens: '-1',
                compression_ratio_threshold: 2.4,
                language: 'en',
                temperature_increment_on_fallback: 0.2,
                length_penalty: null,
                logprob_threshold: -1,
                condition_on_previous_text: true,
                initial_prompt: null,
                task: 'transcribe',
                temperature: 0,
                beam_size: 5,
                best_of: 5
            },
            Bytes: audio
        }, { headers });
        res.send({ status: (get.status === 200) ? true : false, data: get.data });
    } catch (e) {
        console.log(e);
        res.send({ status: false, message: "An error has ocurred" })
    }
});

const STT_API_HOSTS = [
    "https://abidlabs-whisper-large-v2.hf.space/run/predict",
    "https://sanchit-gandhi-whisper-large-v2.hf.space/run/predict"
];

const fetchStt = async function (index = 1, name = `audio_${Date.now()}.wav`, base64, audioType = "audio/wav") {
    if (index === 0) {
        const res = await fetch(STT_API_HOSTS[0], {
            method: "POST",
            body: JSON.stringify({
                data: [
                    {
                        name: name,
                        data: `data:${audioType};base64,${base64}`
                    },
                    null
                ]
            }),
            headers: {
                "Content-Type": "application/json"
            }
        });
        const json = await res.json();
        return {
            status: res.status === 200 ? true : false, data: {
                text: json?.data[0]
            }
        };
    }
    else if (index === 1) {
        const res = await fetch(STT_API_HOSTS[1], {
            method: "POST",
            body: JSON.stringify({
                data: [
                    null,
                    {
                        name: name,
                        data: `data:${audioType};base64,${base64}`
                    },
                    "transcribe"
                ]
            }),
            headers: {
                "Content-Type": "application/json"
            }
        });
        const json = await res.json();
        return {
            status: res.status === 200 ? true : false, data: {
                text: json?.data[0]
            }
        };
    }
}

app.post("/stt", async (req, res) => {
    const { audio, provider, name, audioType } = req.body;
    if (!audio) return res.send({ status: false, message: "Invalid body" });

    try {
        const data = await fetchStt(provider, name, audio, audioType);
        res.send(data);
    } catch (e) {
        console.log(e)
        res.send({ status: false, message: "An error has ocurred" })
    }
});

const ttsClient = new Text2Speech("en-US");
app.get("/tts", async (req, res) => {
    const { text } = req.query;
    if (!text) return res.send({ status: false, message: "Invalid payload" });
    try {
        res.setHeader("Content-Type", "audio/wav");
        const stream = await ttsClient.stream(text);
        stream.pipe(res);
    } catch (e) {
        console.log(e);
        res.send({ status: false, message: "An error has ocurred" })
    }
});

app.listen(3000, () => {
    console.log("API: Loaded")
});
