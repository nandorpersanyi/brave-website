/* jshint asi: true */
/* jshint esversion: 6 */

'use strict'

const Hapi = require('hapi')
var assets = require('./assets.js')
var mailchimp = require('./mailchimp.js')
var Blankie = require('blankie')
var Scooter = require('scooter')

const server = new Hapi.Server()
var useragent = require('useragent')

server.connection({ port: process.env.PORT || 3000 })

server.register({
  register: require('crumb'),
  options: {
    cookieOptions: {
      clearInvalid: true,
      isSecure: true
    },
    skip: function (request, reply) {
      return request.route.path !== '/api/mailchimp' && request.route.path !== '/api/crumb'
    }
  }
}, (err) => {
  if (err) {
    console.log('Failed to load crumb.')
  }
})

server.register(require('inert'), (err) => {
  if (err) {
    console.log('Failed to load inert.')
  }
})

// Register Blankie to make use CSP directives
server.register([Scooter, { register: Blankie }], (err) => {
  if (err) {
    console.log(err)
  }
})

/* API endpoints */

// fastly purge
server.route({
  method: 'POST',
  path: '/api/purge',
  handler: function (request, reply) {
    if (request.query['fastly_api_key'] ===  process.env.FASTLY_API_KEY) {
      require('fastly')(process.env.FASTLY_API_KEY).purgeAll(process.env.FASTLY_SERVICE_ID, function (err, obj) {
        if (err) {
          console.dir(err)
          reply(err)
        } else {
          reply('sucess')
        }
      })
    } else {
      reply('bad api key')
    }
  }
})

// mailchimp methods
server.route({
  method: 'POST',
  path: '/api/mailchimp',
  config: {
    state: {
      parse: true,
      failAction: 'log'
    },
    security: {
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
      , xframe: true
    }
  },
  handler: function (request, reply) {
    mailchimp.api(request, reply)
  }
})

// crumb
server.route({
  method: 'GET',
  path: '/api/crumb',
  config: {
    state: {
      parse: true,
      failAction: 'log'
    },
    security: {
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
      , xframe: true
    }
  },
  handler: function (request, reply) {
    reply({cookie: request.headers.cookie})
  }
})

const downloadRedirects = (ua) => {
  var agent = useragent.parse(ua)
  var os = agent.os.toString()
  if (os.match(/^iOS/)) {
   return "https://itunes.apple.com/ca/app/brave-web-browser/id1052879175?mt=8#"
  }
  if (os.match(/^Android/)) {
   return 'https://play.google.com/store/apps/details?id=com.linkbubble.playstore'
  }
  return 'https://github.com/brave/browser-laptop/releases'
}

// Download links
server.route({
  method: 'GET',
  path: '/api/download',
  config: {
   state: {
     failAction: 'log'
   }
  },
  handler: function (request, reply) {
   reply().redirect(downloadRedirects(request.headers['user-agent']))
  }
})


var map = [
  { path: '/privacy_android', file: './public/android_privacy.html' },
  { path: '/privacy_ios', file: './public/ios_privacy.html' },
  { path: '/terms_of_use', file: './public/terms_of_use.html' },
  { path: '/downloads', file: './public/downloads.html' }
]



// A server redirect to our favorite band, Brave Combo.
server.route({
  method: 'GET',
  path: '/bo/{path*}',
  handler: function (request, reply) {
    reply.redirect('http://bravecombo.com/' + (request.params.path ? request.params.path : ''))
  }
})

map.forEach((entry) => {
  server.route({
    method: 'GET',
    path: entry.path,
    config: {
      state: {
        failAction: 'log'
      }
    },
    handler: {
      file: entry.file
    }
  })
})

// Serves static files out of public/
server.route({
  method: 'GET',
  path: '/{path*}',
  config: {
    state: {
      parse: true,
      failAction: 'log'
    },
    security: {
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      },
      xframe: true
    },
    plugins: {
      blankie: {
        frameAncestors: 'chrome-extension://mnojpmjdmbbfmejpflffifhffcmidifd',
        defaultSrc: '\'self\'',
        styleSrc: '\'unsafe-inline\' https://fonts.googleapis.com/ \'self\'',
        scriptSrc: '\'unsafe-inline\' *.brave.com *.greenhouse.io \'self\'',
        fontSrc: 'https://fonts.gstatic.com data: \'self\'',
        imgSrc:  '*.brave.com *.greenhouse.io \'self\'',
        frameSrc: 'https://widget.battleforthenet.com *.greenhouse.io', // REMOVE THIS AFTER 7/12/2017
        // don't generate nonces automatically
        generateNonces: false
      }
    }
  },
  handler: {
    directory: {
      path: './public'
    }
  }
})

// DO NOT CHANGE OR REMOVE THIS UNLESS YOU KNOW EXACTLY WHAT YOU ARE DOING
// We want Fastly to serve all of the static content and only update
// edge caches when purges are triggered. Other methods (etags, etc...)
// will make too many requests to Heroku and latency to responses
server.ext('onPreResponse', function(request, reply) {
  var res = request.response
  if (res && res.isBoom) {
    res.output.headers['cache-control'] = 'private'
    res.output.headers['Surrogate-Control'] = 'private'
    if (res.output.statusCode === 404) {
      var out = reply.file('public/404.html').code(404)
      out.headers['cache-control'] = 'private'
      out.headers['Surrogate-Control'] = 'private'
      return out
    }
  } else {
    if (request.method !== 'get') {
      request.response.headers['cache-control'] = 'private' // override no-cache
      request.response.headers['Surrogate-Control'] = 'private' // override no-cache
    } else {
      if (request.response.statusCode === 200) {
        request.response.headers['cache-control'] = 'public' // override no-cache
        // send surrogate control headers for Fastly
        // this will cache files at the fastly edge servers for a long
        // period of time or until purged, but the browser will
        // use the default cache-control settings and etags when
        // making requests to Fastly
        request.response.headers['Surrogate-Control'] = 'max-age=2592000'
      }
    }
  }
  reply(request.response)
})

server.start(() => {
  console.log('Brave server running at:', server.info.uri);
});
