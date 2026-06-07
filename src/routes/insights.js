const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');
const { analyzeInsights } = require('../services/claude');

router.use(authMiddleware, requireRole('admin', 'evelyn', 'editor'));

router.get('/', async (req, res) => {
  try {
    const token = process.env.META_ADS_ACCESS_TOKEN;
    const accountId = process.env.META_AD_ACCOUNT_ID;

    if (!token || !accountId) {
      return ok(res, { message: 'META_ADS_ACCESS_TOKEN e META_AD_ACCOUNT_ID não configurados', campaigns: [] });
    }

    const url = `https://graph.facebook.com/v20.0/act_${accountId}/campaigns?fields=id,name,status,objective,insights{impressions,reach,clicks,ctr,spend,actions}&access_token=${token}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.error) return fail(res, data.error.message);
    ok(res, data);
  } catch (e) { fail(res, e.message); }
});

router.post('/suggest', async (req, res) => {
  try {
    const { campaignData } = req.body;
    if (!campaignData) return fail(res, 'campaignData obrigatório', 400);

    const analysis = await analyzeInsights({ campaignData });
    ok(res, { analysis });
  } catch (e) { fail(res, e.message); }
});

module.exports = router;
