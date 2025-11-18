const router = require('express').Router();
const subscriptionCtrl = require('../controllers/subscriptionController_new');
const { isAuthenticated } = require('../middlewares/isAuthenticated');

// Create order (requires auth for attaching user)
router.post('/create', isAuthenticated, subscriptionCtrl.createOrder);
// Verify payment (frontend posts payment ids)
router.post('/verify', subscriptionCtrl.verifyPayment);
// Renew subscription (requires auth; checks expiry first)
router.post('/renew', isAuthenticated, subscriptionCtrl.renewSubscription);
router.get("/all-users-subscription",subscriptionCtrl.AllUsersSubscription)



module.exports = router;
