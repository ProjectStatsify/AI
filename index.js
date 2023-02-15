import defaultPuppeteer from "puppeteer";
import { addExtra } from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import useragent from "puppeteer-extra-plugin-anonymize-ua";
import { createParser } from 'eventsource-parser';
import express from "express";
import qs from "querystring";

const puppeteer = addExtra(defaultPuppeteer);
puppeteer.use(stealth());
puppeteer.use(useragent());

const app = express();
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
const browser = await puppeteer.launch(options);

const BASE_URL = "https://you.com/api/streamingSearch";
console.log("BROWSER: Process launched");

app.all("/chat", async (req, res) => {
    const query = req.body?.q ?? req.query.q;
    if (!query) return res.status(404).send({ status: false, message: "Invalid request payload" });

    const vars = {
        page: 1,
        count: 10,
        safeSearch: "Moderate",
        onShoppingPage: false,
        responseFilter: ["WebPages", "Translations", "TimeZone", "Computation", "RelatedSearches"],
        domain: "youchat",
        q: query
    };

    const reqURL = `${BASE_URL}?${qs.stringify(vars)}`;

    const page = await browser.newPage();
    await page.goto(reqURL);

    const pageContent = await page.evaluate(() => document.body.textContent);

    let data = {
        error: false,
        content: "",
        intents: null,
        requestOptions: vars

    };
    const parser = createParser((stream) => {
        if (stream.type === 'event') {
            if (stream.event === "youChatToken") {
                const streamData = JSON.parse(stream.data);
                data.content += streamData["youChatToken"];
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
    res.send({
        status: !data.error, data: {
            ...data,
            content: data.content.trimStart()
        }
    });

});


app.listen(3000, () => {
    console.log("API: Loaded")
});