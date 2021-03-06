import _ from 'lodash';
import RSS from 'rss';
import url from 'url';
import path from 'path';
import express from 'express';
import request from 'request-promise-native';
import asyncHandler from 'express-async-handler';
import * as recaptcha from '../services/recaptcha';
import * as blogPosts from '../services/blogPosts';
import * as comments from '../services/comments';
import * as akismet from '../services/akismet';
import * as emails from '../services/emails';
import * as events from '../services/events';
import { cachePageHandler, cacheAndReturn, clearPageCache } from '../services/cache';
import { preparePost, preparePostJson, blogpostUrl } from './util';
import { config } from '../app';

const router = express.Router();
const rss = new RSS({
  title: config.blog.title,
  description: config.blog.description,
  site_url: config.blog.url,
  generator: 'elastic-blog-engine'
});

const PAGE_SIZE = 10;

events.onChange('post', () => clearPageCache(config.blog['blog-route-prefix']));
router.get('/', cachePageHandler(asyncHandler(handlePostsRequest('index'))));

router.get('/page/:pageNum', asyncHandler(handlePostsRequest('index')));
router.get('/tagged/:tag', asyncHandler(handlePostsRequest('tagged')));
router.get('/tagged/:tag/page/:pageNum', asyncHandler(handlePostsRequest('tagged')));
router.get('/search', asyncHandler(handlePostsRequest('search')))
router.get('/search/page/:pageNum', asyncHandler(handlePostsRequest('search')))

router.get('/rss', asyncHandler(async (req, res) => {
  const { items } = await cacheAndReturn('recent-items', async () => {
    return blogPosts.getItems({ type: 'post', pageIndex: 0, pageSize: 10 })
  });

  const recentPosts = items.map(preparePost);

  res.type('application/rss+xml');
  recentPosts.forEach(post => rss.item({
    title: post.title,
    description: post.description,
    url: url.resolve(config.blog.url, post.url),
    categories: post.tags,
    date: new Date(post.published_at)
  }));
  res.send(rss.xml());
}));

const BLOGPOST_ROUTE = '/:year(\\d+)/:month(\\d+)/:id-:slug';

router.use(BLOGPOST_ROUTE, (req, res, next) => {
  const { slug, isJson } = parseSlug(req.params.slug);

  res.locals.logData = {
    read_item: {
      slug,
      id: blogPosts.BLOGPOST_ID_PREFIX + req.params.id,
      type: 'post',
      is_json: isJson
    }
  };
  next();
});

events.onChange('post', post => clearPageCache(blogpostUrl(post)));
router.get(BLOGPOST_ROUTE, cachePageHandler(asyncHandler(async (req, res) => {
  const { slug, isJson } = parseSlug(req.params.slug);

  let post = await blogPosts.getItemById(blogPosts.BLOGPOST_ID_PREFIX + req.params.id, true);
  if (post.slug !== slug) {
    res.redirect(blogpostUrl(post));
    return;
  }

  if (! _.isEmpty(post.private_viewing_key)) {
    if (post.private_viewing_key !== req.query.secret) {
      res.status(404).render('error', {
        message: 'Post not found',
        error: {
          status: 404
        }
      });
      return;
    }
  }

  if (isJson) {
    res.json(preparePostJson(post));
    return;
  }

  const preparedPost = preparePost(post);

  let canonicalUrl = _.get(post, 'metadata.canonical_url', '');
  if (! canonicalUrl.length) {
    canonicalUrl = url.resolve(config.blog.url, preparedPost.url);
  }

  res.render('post', {
    canonicalUrl,
    sidebarWidgetData: res.locals.sidebarWidgetData,
    headerImageUrl: post.metadata.header_image_url,
    recaptchaClientKey: recaptcha.clientKey(),
    title: post.title,
    description: post.description,
    post: preparedPost
  });
})));

router.post(BLOGPOST_ROUTE, asyncHandler(async (req, res) => {
  let commentError = null;
  let validity = null;
  let repliedToComment = null;
  let isSpam = false;

  try {
    if (recaptcha.isAvailable()) {
      const success = await recaptcha.verify(req.body['g-recaptcha-response']);
      if (! success) {
        const captchaErr = new Error();
        captchaErr.isRecaptcha = true;
        throw captchaErr;
      }
    }

    if (akismet.isAvailable()) {
      isSpam = await akismet.checkSpam({
        user_ip: req.connection.remoteAddress,
        user_agent: req.get('User-Agent'),
        referrer: req.get('Referrer'),
        comment_type: 'comment',
        comment_author: req.body.author,
        comment_author_email: req.body.email,
        comment_author_url: req.body.website,
        comment_content: req.body.content,
      });
    }

    const resp = await comments.createComment({
      recipient_path: _.isEmpty(req.body.recipient_path) ? null : req.body.recipient_path,
      post_id: blogPosts.BLOGPOST_ID_PREFIX + req.params.id,
      author: {
        name: req.body.author,
        email: req.body.email,
        website: req.body.website
      },
      content: req.body.content,
      user_host_address: req.connection.remoteAddress,
      user_agent: req.get('User-Agent'),
      spam: isSpam
    });

    repliedToComment = resp.repliedToComment;
  }
  catch (err) {
    if (err.isRecaptcha) {
      commentError = 'Invalid recaptcha';
    }
    else if (err.isJoi) {
      validity = {};
      err.details.forEach(err => {
        err.path.forEach(key => validity[key] = 'has-error');
      });
      commentError = 'Please fill all required fields';
    }
    else {
      throw err;
    }
  }

  const post = await blogPosts.getItemById(blogPosts.BLOGPOST_ID_PREFIX + req.params.id, true);

  if (! commentError && config.blog['comments-noreply-email']) {
    const opAndComment = {
      opEmail: post.author.email,
      opTitle: post.title,
      opUrl: url.resolve(config.blog.url, blogpostUrl(post)),
      comment: {
        email: req.body.email,
        author: req.body.author,
        website: req.body.website,
        content: req.body.content
      }
    };

    if (repliedToComment) {
      emails.sendNewCommentNotification({
        ...opAndComment,
        opComment: {
          email: repliedToComment.author.email,
          author: repliedToComment.author.name,
          website: repliedToComment.author.website,
          content: repliedToComment.content
        }
      });
    }
    else {
      emails.sendNewCommentNotification(opAndComment);
    }
  }

  events.emitChange('post', post);

  if (! commentError) {
    res.redirect(303, req.originalUrl);
    return;
  }

  res.render('post', {
    sidebarWidgetData: res.locals.sidebarWidgetData,
    comments: {
      validity,
      error: commentError,
      values: commentError ? req.body : null
    },
    recaptchaClientKey: recaptcha.clientKey(),
    post: preparePost(post)
  });
}));


export default router;

function handlePostsRequest(template) {
  return async (req, res) => {
    const { pageNum, tag } = req.params;
    const pageIndex = _.isUndefined(pageNum) ? 0 : parseFloat(pageNum) - 1;
    const { items, total, totalPages } = await blogPosts.getItems({
      type: 'post',
      search: _.isEmpty(req.query.q) ? null : req.query.q,
      tag,
      pageIndex,
      pageSize: PAGE_SIZE
    });

    res.locals.logData = {
      list_items: {
        search_query: req.query.q,
        tag: tag,
        page_index: pageIndex,
        page_size: PAGE_SIZE
      }
    };

    res.render(template, {
      tag,
      total,
      totalPages,
      searchQuery: req.query.q,
      sidebarWidgetData: res.locals.sidebarWidgetData,
      pageSize: PAGE_SIZE,
      pageNum: pageIndex + 1,
      prevPage: pageIndex > 0 ? pageIndex : null,
      nextPage: pageIndex + 1 < totalPages ? pageIndex + 2 : null,
      posts: items.map(preparePost)
    });
  };
}


function parseSlug(slug) {
  if (slug.endsWith('.json')) {
    return {
      slug: slug.slice(0, -5),
      isJson: true
    };
  }

  return {
    slug,
    isJson: false
  };
}
