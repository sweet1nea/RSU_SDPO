const express = require('express');
const catchAsync = require('../helpers/catchAsync');
const authMiddleware = require('../middlewares/authMiddleware');
const ctrl = require('../controllers/notification.controller');

const router = express.Router();

router.use(authMiddleware);
router.get('/', catchAsync(ctrl.list));
router.patch('/read-all', catchAsync(ctrl.markAllRead));
router.patch('/:id/read', catchAsync(ctrl.markRead));
router.delete('/read', catchAsync(ctrl.removeAllRead));
router.delete('/:id', catchAsync(ctrl.remove));

module.exports = router;
