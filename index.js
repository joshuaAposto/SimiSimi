const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { NlpManager } = require('node-nlp');
const moment = require('moment-timezone');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const util = require('util');
const { check, validationResult } = require('express-validator');
const Fuse = require('fuse.js');

const app = express();
const PORT = 3000;
const API_KEY_EXPIRY_DAYS = 7;
const API_KEY = 'apikeys.json';
const EXPIRY_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

const db = new sqlite3.Database('database.sqlite');
db.all = util.promisify(db.all);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const manager = new NlpManager({ languages: ['en', 'tl', 'es', 'fr'], nlu: { useNext: true } });

const initializeDatabase = async () => {
    await db.run('CREATE TABLE IF NOT EXISTS responses (question TEXT, answer TEXT)');
};

const loadResponses = async () => {
    const rows = await db.all('SELECT question, answer FROM responses');
    rows.forEach(row => {
        ['en', 'tl', 'es', 'fr'].forEach(lang => {
            manager.addDocument(lang, row.question, row.question);
            manager.addAnswer(lang, row.question, row.answer);
        });
    });
    await manager.train();
    manager.save();
};

const loadApiKeys = () => {
    return fs.existsSync(API_KEY) ? JSON.parse(fs.readFileSync(API_KEY)) : [];
};

const saveApiKeys = (apiKeys) => {
    fs.writeFileSync(API_KEY, JSON.stringify(apiKeys, null, 2));
};

const validateApiKey = (apiKey) => {
    const apiKeys = loadApiKeys();
    const keyData = apiKeys.find(key => key.api_key === apiKey);
    return keyData && new Date(keyData.expiration) > new Date();
};

const generateApiKey = (ip) => {
    const apiKeys = loadApiKeys();
    const existingKey = apiKeys.find(key => key.ip === ip);
    const currentTime = new Date();
    if (existingKey) {
        if (new Date(existingKey.expiration) > currentTime) {
            return existingKey.api_key;
        } else {
            apiKeys.splice(apiKeys.indexOf(existingKey), 1);
        }
    }
    const apiKey = `nsh-${crypto.randomBytes(16).toString('hex')}`;
    const expiration = new Date();
    expiration.setDate(expiration.getDate() + API_KEY_EXPIRY_DAYS);
    const newKey = { api_key: apiKey, expiration, ip };
    apiKeys.push(newKey);
    saveApiKeys(apiKeys);
    return apiKey;
};

const deleteExpiredApiKeys = () => {
    const apiKeys = loadApiKeys();
    const updatedApiKeys = apiKeys.filter(key => new Date(key.expiration) > new Date());
    saveApiKeys(updatedApiKeys);
};

app.get('/apikey', (req, res) => {
    const apiKey = generateApiKey(req.ip);
    res.status(200).json({ apiKey });
});

app.get('/api/keys', (req, res) => {
    res.status(200).json(loadApiKeys());
});

app.get('/sim', [
    check('prompt').isString(),
    check('apiKey').isString()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { prompt, apiKey, language = 'en' } = req.query;
    if (!validateApiKey(apiKey)) return res.status(403).json({ message: 'Invalid API key' });

    try {
        const response = await manager.process(language, prompt);
        if (response.answer) return res.status(200).json({ response: response.answer });

        const questions = (await db.all('SELECT question FROM responses')).map(row => row.question);
        const fuse = new Fuse(questions, { threshold: 0.3 });
        const closestMatch = fuse.search(prompt);

        return closestMatch.length > 0 
            ? res.status(200).json({ response: `Did you mean: "${closestMatch[0].item}"?` }) 
            : res.status(200).json({ response: 'I\'m not sure how to respond to that. Ask something else.' });
    } catch (err) {
        return res.status(500).json({ message: 'Error retrieving responses' });
    }
});

app.get('/teach', [
    check('question').isString(),
    check('answer').isString()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { question, answer } = req.query;

    try {
        const exists = await db.all('SELECT answer FROM responses WHERE question = ? AND answer = ?', [question, answer]);
        if (exists.length > 0) return res.status(200).json({ message: 'This answer already exists for the question' });

        const stmt = db.prepare('INSERT INTO responses (question, answer) VALUES (?, ?)');
        stmt.run(question, answer);
        stmt.finalize();

        ['en', 'tl', 'es', 'fr'].forEach(lang => {
            manager.addDocument(lang, question, question);
            manager.addAnswer(lang, question, answer);
        });

        await manager.train();
        manager.save();
        res.status(200).json({ message: 'Training successful' });
    } catch (err) {
        return res.status(500).json({ message: 'Error training the chatbot' });
    }
});

const learn = async () => {
    const rows = await db.all('SELECT question, answer FROM responses');
    const responsesMap = {};

    rows.forEach(row => {
        const { question, answer } = row;
        responsesMap[question] = responsesMap[question] ? [...responsesMap[question], answer] : [answer];
    });

    for (const question in responsesMap) {
        const answers = [...new Set(responsesMap[question])];
        answers.forEach(answer => {
            manager.addAnswer('en', question, answer);
            manager.addAnswer('tl', question, answer);
            manager.addAnswer('es', question, answer);
            manager.addAnswer('fr', question, answer);
        });
    }
    
    ['en', 'tl', 'es', 'fr'].forEach(lang => {
        manager.addDocument(lang, prompt, prompt);
    });

    await manager.train();
    manager.save();
};

setInterval(learn, EXPIRY_CHECK_INTERVAL);

const checkExpiredApiKeys = () => {
    deleteExpiredApiKeys();
};

setInterval(checkExpiredApiKeys, EXPIRY_CHECK_INTERVAL);

initializeDatabase();
loadResponses();

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});