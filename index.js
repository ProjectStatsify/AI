import puppeteer from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import useragent from "puppeteer-extra-plugin-anonymize-ua";
import { createParser } from 'eventsource-parser';
import express from "express";
import qs from "querystring";
import StableHorde from "@zeldafan0225/stable_horde";
import expressWs from "express-ws";

puppeteer.use(stealth());
puppeteer.use(useragent());

const app = express();
expressWs(app);
app.use(express.json());
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

let browser = await puppeteer.launch(options);
console.log("BROWSER: Process launched");

const API_BASE_URL = "https://you.com/api/streamingSearch";
const BASE_URL = "https://you.com/chat";

const traceIdMap = new Map();
const fetchQueryTraceToken = async (traceId) => {
    const existingQueryTraceId = traceIdMap.get(traceId);
    if (existingQueryTraceId) return existingQueryTraceId;
    else {
        return new Promise(async (resolve, reject) => {
            const page = await browser.newPage();
            await page.setRequestInterception(true);

            page.on("request", async (interceptedRequest) => {
                if (interceptedRequest.url().startsWith(API_BASE_URL)) {
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
            await page.goto(BASE_URL);

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
        queryTraceId : traceToken,
        chatId : traceToken
    };

    const reqURL = `${API_BASE_URL}?${qs.stringify(vars)}`;

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

        if(metadata) data.metaData = vars;
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
    cache_interval: 1000 * 10,
    client_agent: "Statsify:v0.0.1:mail@statsify.ga"
});


app.all("/art/generate", async (req, res) => {
    const prompt = req.body?.q ?? req.query.q;
    if (!prompt) return res.status(404).send({ status: false, message: "Invalid request payload" });

    const data = await artClient.postAsyncGenerate({
        prompt,
        ...req.query,
        ...req.body
    });

    res.send({
        status: data.id ? true : false, data: {
            ...data,
            ws: `art/ws/${data.id}`
        }
    });
});

app.get("/art/:id", async (req, res) => {
    const { id } = req.params;
    const data = await artClient.getGenerationStatus(id).catch(() => null);
    if (data) res.send({ status: true, data })
    else res.send({ status: false, message: "No found" })
});

app.ws(`/art/ws/:id`, async (ws, req) => {
    const { id } = req.params;
    const check = await artClient.getGenerationCheck(id).catch(() => null);
    if (!check) return ws.close();
    send(ws);
    const checkStatus = setInterval(() => send(ws), 1000 * 10);
    async function send(ws) {
        const status = await artClient.getGenerationStatus(id).catch(() => null);
        ws.send(JSON.stringify({ status: true, data: status }));
        if (status.done) {
            clearInterval(checkStatus);
            ws.close();
        }
    }
});

app.listen(3000, () => {
    console.log("API: Loaded")
});
