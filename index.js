var argv      = require('yargs').argv
, fs        = require('fs')
, util      = require('util')
, path      = require('path')
, parseXml  = require('xml2js').parseString
, Promise   = require('bluebird')
, pseudoloc = require('pseudoloc')
, _         = require('underscore')
, _s        = require('underscore.string')
, ejs       = require('ejs')
;

/* 
  Fixing bug# 1049399.
  Localization tool adds special escape sequences to resource files.
  The format of a sequence is "]xx;" where xx is character code in hex
  The function below unescapes all such sequences
*/
function unescape(str) {
  function replacer(match, hex){
    return String.fromCharCode(parseInt(hex, 16));
  }
  
  return str.replace(/\]([0-9A-F]{1,4})\;/gi, replacer);
}

// - TODO we are catching errors here; we should warn when keys are missing.
function getHash(json, type){
  var hash = {};

  switch(type) {
    case 'resx':
      var data = json.root.data;
      _.each(data, function(element, index, list){
        Promise.try(function(){
          var key   = element.$.name
          , text  = element.value[0]
          ;

          hash[key] = text;
        })
        .catch(function(){});
      });
      break;
    case 'lspkg':
      var data = json.LocPackage.FileDataList[0].FileData[2].LCX[0].Item[0].Item[0].Item;
      _.each(data, function(element, index, list){
        Promise.try(function(){
          var key   = element.$.ItemId.substring(1) // trim leading ;
          , text  = unescape(element.Str[0].Tgt[0].Val[0])
          ;
          hash[key] = text;
        })
        .catch(function(){});
      });
      break;
  }

  return hash;
};

function filter_and_fallback(hash, targets, fallbackHash) {  
  if (targets) {
    var hash         = hash || {}
      , fallbackHash = fallbackHash || {};
    
    return _.map(targets, function(tg_item){          
      var filtered  = {};

      _.each(tg_item.whiteList, function (value, key, list) {
        var names = _.size(value)? value : [key]
        , res   = _.has(hash, key)? hash[key] : fallbackHash[key];

        if (res) {
          _.each(names, function(name){
            filtered[name] = res;
          });
        }
      });
      
      return {
        filtered  : filtered,
        dest      : tg_item.dest
      }      
    });
        
  }

  return hash;
}

function generateModuleText(hash, ejs_template) {
  return ejs.render(ejs_template, {
    items : _.pairs(hash)
    , lib   : {
      _s  : _s
    }
  });
}

function loadWhiteLists(targets) {
  var eol = require('os').EOL;

  return Promise
    .resolve(targets)
    .map(function(tg_item) {

      if (_.isArray(tg_item.whiteList) || _.isString(tg_item.whiteList)) {
        return Promise
          .resolve(_.isArray(tg_item.whiteList) ? tg_item.whiteList : [tg_item.whiteList])
          .map(function(wl_file) {
            return Promise
              .promisify(fs.readFile)(wl_file, 'utf8');
          })
          .all()
          .then(function (wl_filesContent) {
            var mergedContent = wl_filesContent.join(eol),
              whiteList = parseWhiteList(mergedContent);
            return {
              whiteList: whiteList,
              dest : tg_item.dest
            }
          });

      } else if (_.isObject(tg_item.whiteList)) {
        return Promise.resolve(tg_item);
      } else {
        throw new Error('Incorrect whitelist configuration. Supported options: {object} - pre-populated whitelist, string - file path, [string array] - file paths array');
      }

    });
}

function parseWhiteList(text) {
  var ret   = {}
  , lines = text.split(require('os').EOL)
  ;

  _.each(lines, function(element, index, list){
    var words     = _.map(element.split(','), function(item){ return item.trim(); })
    , resx_key  = words[0]
    , aliases   = words.slice(1)
    ;

    if (_.has(ret, resx_key)) {
      Array.prototype.push.apply(ret[resx_key], aliases);
    } else {
      ret[resx_key] = aliases;
    }
  });

  return ret;
}


function generateHash(read_uri /*file to read*/, targets /*targets: whitelist urls and dest folders*/, type /*read file type [resx, lspkg]*/, fallbacks /*fallback hash*/, terminal /*is running within the terminal on its own*/) {
  return Promise
    .promisify(fs.readFile)(read_uri)    
    .then(function(xml){
      return Promise.promisify(parseXml)(xml);
    })
    .then(function(json){
      return getHash(json, type || path.extname(read_uri).substring(1));
    });
}

function main(read_uri /*file to read*/, targets /*whitelist file uri or object*/, type /*read file type [resx, lspkg]*/, fallbackHash /*fallback hash*/, terminal /*is running within the terminal on its own*/) {
  return Promise
    .join(
      generateHash(read_uri, targets, type, fallbackHash, terminal),
      loadWhiteLists(targets)
    )
    .spread(function(hash, whitelists){
      return filter_and_fallback(hash, whitelists, fallbackHash)
    })
    .then(function(hash){
      return Promise
      .promisify(fs.readFile)(path.join(__dirname, './template.ejs'), 'utf8')
      .then(function(template){
        return Promise.resolve(hash).map(function(hash_item){
          return {
            dest : hash_item.dest,
            text : generateModuleText(hash_item.filtered, template)
          }
        });      
      });
    })
    .catch(function(err){
      console.error(err);
      throw err;
    });
}

function main_qps_ploc(read_uri /*file to read*/, targets /*whitelist file uri or object*/, type /*read file type [resx, lspkg]*/, fallbackHash /*fallback hash*/, terminal /*is running within the terminal on its own*/) {
  return Promise
    .join(
      generateHash(read_uri, targets, type, fallbackHash, terminal),
      loadWhiteLists(targets)
    )
    .spread(function(hash, whitelists){
      return filter_and_fallback(hash, whitelists, fallbackHash)
    })
    .then(function(hash){
      return Promise
      .promisify(fs.readFile)(path.join(__dirname, './template.ejs'), 'utf8')
      .then(function(template){
        return Promise.resolve(hash).map(function(hash_item){
          _.each(hash_item.filtered, function(value, key, obj){
            obj[key] = pseudoloc.str(value);
          });
      
          return {
            dest : hash_item.dest,
            text : generateModuleText(hash_item.filtered, template)
          }
        });      
      });
    })
    .catch(function(err){
      console.error(err);
      throw err;
    });
}

if (require.main === module) {
  var fstats = fs.statSync(argv.r);

  if (fstats && fstats.isFile()) {
    main(argv.r, argv.w, argv.t, fallbacks, true /*terminal*/)
    .then(function(text){
      console.log(text);
    })
    .catch(function(err){
      console.error(err);
    });
  }
}

module.exports = {
    main            : main
  , main_qps_ploc   : main_qps_ploc
  , generateHash    : generateHash
  , parseWhiteList  : parseWhiteList
  , loadWhiteLists  : loadWhiteLists
};