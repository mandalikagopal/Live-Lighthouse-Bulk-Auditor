import express from 'express';
import fs from 'fs';
import path from 'path';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const REPORTS_DIR = './public/reports';
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const median = arr => {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

async function runSingleAudit(url, formFactor) {
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu']
  });
  const screenEmulation = formFactor === 'mobile'
    ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75 }
    : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1 };
  try {
    return await lighthouse(url, {
      port: chrome.port,
      output: 'html',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      formFactor,
      screenEmulation
    });
  } finally {
    await chrome.kill();
  }
}

app.post('/api/run', async (req, res) => {
  const { urlsText } = req.body;
  const urls = urlsText.split('\n').map(u => u.trim()).filter(Boolean);

  if (!urls.length) {
    return res.status(400).json({ error: 'No URLs provided' });
  }

  // Set headers for Server-Sent Events (SSE) live streaming logs
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendLog = (msg) => {
    res.write(`data: ${JSON.stringify({ type: 'log', message: msg })}\n\n`);
  };

  sendLog(`🚀 Starting audit job for ${urls.length} URLs (Mobile & Desktop)...`);

  const startTime = Date.now();
  const results = [];

  for (let idx = 0; idx < urls.length; idx++) {
    const url = urls[idx];
    sendLog(`\n[${idx + 1}/${urls.length}] Processing: ${url}`);

    let mobileRes = null;
    let desktopRes = null;

    // Run Mobile (2 runs)
    try {
      sendLog(`  ⏳ Running Mobile audits (2x)...`);
      const mRuns = [];
      for (let i = 0; i < 2; i++) {
        const r = await runSingleAudit(url, 'mobile');
        mRuns.push(r);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const mScores = mRuns.map(r => Math.round(r.lhr.categories.performance.score * 100));
      const mMedian = median(mScores);
      const mBest = mRuns.find(r => Math.round(r.lhr.categories.performance.score * 100) === mMedian) || mRuns[0];
      
      const safeName = url.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
      const reportFile = `reports/${safeName}_mobile.html`;
      fs.writeFileSync(`./public/${reportFile}`, mBest.report);

      mobileRes = {
        scores: {
          performance: mMedian,
          accessibility: Math.round(mBest.lhr.categories.accessibility.score * 100),
          seo: Math.round(mBest.lhr.categories.seo.score * 100)
        },
        reportFile: reportFile,
        recommendations: Object.values(mBest.lhr.audits)
          .filter(a => a.details?.type === 'opportunity' && a.score !== null && a.score < 0.9)
          .sort((a, b) => (b.details?.overallSavingsMs || 0) - (a.details?.overallSavingsMs || 0))
          .slice(0, 3)
          .map(a => ({ title: a.title, savingsMs: Math.round(a.details?.overallSavingsMs || 0), displayValue: a.displayValue || '' }))
      };
      sendLog(`  ✔️ Mobile Perf Median: ${mMedian}`);
    } catch (err) {
      sendLog(`  ❌ Mobile audit failed: ${err.message}`);
    }

    // Run Desktop (2 runs)
    try {
      sendLog(`  ⏳ Running Desktop audits (2x)...`);
      const dRuns = [];
      for (let i = 0; i < 2; i++) {
        const r = await runSingleAudit(url, 'desktop');
        dRuns.push(r);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const dScores = dRuns.map(r => Math.round(r.lhr.categories.performance.score * 100));
      const dMedian = median(dScores);
      const dBest = dRuns.find(r => Math.round(r.lhr.categories.performance.score * 100) === dMedian) || dRuns[0];
      
      const safeName = url.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
      const reportFile = `reports/${safeName}_desktop.html`;
      fs.writeFileSync(`./public/${reportFile}`, dBest.report);

      desktopRes = {
        scores: {
          performance: dMedian,
          accessibility: Math.round(dBest.lhr.categories.accessibility.score * 100),
          seo: Math.round(dBest.lhr.categories.seo.score * 100)
        },
        reportFile: reportFile,
        recommendations: Object.values(dBest.lhr.audits)
          .filter(a => a.details?.type === 'opportunity' && a.score !== null && a.score < 0.9)
          .sort((a, b) => (b.details?.overallSavingsMs || 0) - (a.details?.overallSavingsMs || 0))
          .slice(0, 3)
          .map(a => ({ title: a.title, savingsMs: Math.round(a.details?.overallSavingsMs || 0), displayValue: a.displayValue || '' }))
      };
      sendLog(`  ✔️ Desktop Perf Median: ${dMedian}`);
    } catch (err) {
      sendLog(`  ❌ Desktop audit failed: ${err.message}`);
    }

    results.push({ url, mobile: mobileRes, desktop: desktopRes });
  }

  const durationMinutes = ((Date.now() - startTime) / 60000).toFixed(1);
  const valid = results.filter(r => r.mobile || r.desktop);
  const avg = (dev, key) => {
    const scores = valid.map(r => r[dev]?.scores?.[key]).filter(s => s !== undefined);
    return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  };

  const dashboardData = {
    generatedAt: new Date().toISOString(),
    durationMinutes,
    totalUrls: urls.length,
    overall: {
      mobile: { performance: avg('mobile', 'performance'), accessibility: avg('mobile', 'accessibility'), seo: avg('mobile', 'seo') },
      desktop: { performance: avg('desktop', 'performance'), accessibility: avg('desktop', 'accessibility'), seo: avg('desktop', 'seo') }
    },
    pages: results
  };

  fs.writeFileSync('./public/results.json', JSON.stringify(dashboardData, null, 2));
  sendLog(`\n🎉 All audits completed in ${durationMinutes} mins! Rendering dashboard...`);
  
  res.write(`data: ${JSON.stringify({ type: 'done', data: dashboardData })}\n\n`);
  res.end();
});

app.listen(3000, () => {
  console.log('Server started! Open http://localhost:3000 in your browser.');
});