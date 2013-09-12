var version = require('./package.json').version;
module.exports = function (platform) {
  platform.agent = platform.agent || "js-git/" + version;
  var applyDelta = require('./apply-delta.js')(platform);

  return newRepo;

  // platform options are: db, proto, and trace
  function newRepo(db, workDir) {
    var trace = platform.trace;
    var sha1 = platform.sha1;
    var bops = platform.bops;

    var encoders = {
      commit: encodeCommit,
      tag: encodeTag,
      tree: encodeTree,
      blob: encodeBlob
    };

    var decoders = {
      commit: decodeCommit,
      tag: decodeTag,
      tree: decodeTree,
      blob: decodeBlob
    };

    var repo = {};

    if (db) {
      // Git Objects
      repo.load = load;       // (hashish) -> object
      repo.save = save;       // (object) -> hash
      repo.loadAs = loadAs;   // (type, hashish) -> value
      repo.saveAs = saveAs;   // (type, value) -> hash
      repo.remove = remove;   // (hashish)
      repo.unpack = unpack;   // (opts, packStream)

      // Refs
      repo.resolveHashish = resolveHashish; // (hashish) -> hash
      repo.updateHead = updateHead;         // (hash)
      repo.getBranch = getBranch;           // () -> branchName
      repo.setBranch = setBranch;           // (branchName)
      repo.createBranch = createBranch;     // (branchName, hash)
      repo.deleteBranch = deleteBranch;     // (branchName)
      repo.listBranches = listBranches;     // () -> branchNames
      repo.createTag = createTag;           // (tagName, hash)
      repo.deleteTag = deleteTag;           // (tagName)
      repo.listTags = listTags;             // () -> tagNames
      repo.listRefs = listRefs;             // () -> refs

      if (workDir) {
        // TODO: figure out API for working repos
      }
    }

    // Network Protocols

    repo.lsRemote = lsRemote;
    if (db) {
      repo.fetch = fetch;
      repo.push = push;
    }

    return repo;

    function load(hashish, callback) {
      if (!callback) return load.bind(this, hashish);
      return resolveHashish(hashish, function (err, hash) {
        if (err) return callback(err);
        return db.load(hash, function (err, buffer) {
          if (err) return callback(err);
          var type, object;
          try {
            if (sha1(buffer) !== hash) {
              throw new Error("Hash checksum failed for " + hash);
            }
            var pair = deframe(buffer);
            type = pair[0];
            buffer = pair[1];
            object = {
              type: type,
              body: decoders[type](buffer)
            };
          } catch (err) {
            if (err) return callback(err);
          }
          if (trace) trace("load", null, hash);
          return callback(null, object, hash);
        });
      });
    }

    function save(object, callback) {
      if (!callback) return save.bind(this, object);
      var buffer, hash;
      try {
        buffer = encoders[object.type](object.body);
        buffer = frame(object.type, buffer);
        hash = sha1(buffer);
      }
      catch (err) {
        return callback(err);
      }
      return db.save(hash, buffer, function (err) {
        if (err) return callback(err);
        if (trace) trace("save", null, hash);
        return callback(null, hash);
      });
    }

    function loadAs(type, hashish, callback) {
      if (!callback) return loadAs.bind(this, type, hashish);
      return load(hashish, function (err, object, hash) {
        if (err) return callback(err);
        if (object.type !== type) {
          return new Error("Expected " + type + ", but found " + object.type);
        }
        return callback(null, object.body, hash);
      });
    }

    function saveAs(type, body, callback) {
      if (!callback) return saveAs.bind(this, type, body);
      return save({ type: type, body: body }, callback);
    }

    function remove(hashish, callback) {
      if (!callback) return remove.bind(this, hashish);
      return resolveHashish(hashish, function (err, hash) {
        if (err) return callback(err);
        return db.remove(hash, function (err) {
          if (err) return callback(err);
          if (trace) trace("remove", null, hash);
          return callback(null, hash);
        });
      });
    }

    function resolveHashish(hashish, callback) {
      if (!callback) return resolveHashish.bind(this, hashish);
      hashish = hashish.trim();
      if ((/^[0-9a-f]{40}$/i).test(hashish)) {
        return callback(null, hashish.toLowerCase());
      }
      if (hashish === "HEAD") {
        return getBranch(function (err, ref) {
          if (err) return callback(err);
          if (trace) trace("resolve", null, hashish + " " + ref);
          return resolveHashish(ref, callback);
        });
      }
      if ((/^refs\//).test(hashish)) {
        return db.read(hashish, checkBranch);
      }
      return checkBranch();
      function checkBranch(err, hash) {
        if (err) return callback(err);
        if (hash) {
          if (trace) trace("resolve", null, hashish + " " + hash);
          return resolveHashish(hash, callback);
        }
        return db.read("refs/heads/" + hashish, checkTag);
      }
      function checkTag(err, hash) {
        if (err) return callback(err);
        if (hash) {
          if (trace) trace("resolve", null, hashish + " " + hash);
          return resolveHashish(hash, callback);
        }
        return db.read("refs/tags/" + hashish, final);
      }
      function final(err, hash) {
        if (err) return callback(err);
        if (hash) {
          if (trace) trace("resolve", null, hashish + " " + hash);
          return resolveHashish(hash, callback);
        }
        return callback(new Error("Cannot find hashish: " + hashish));
      }
    }

    function updateHead(hash, callback) {
      if (!callback) return updateHead.bind(this, hash);
      return getBranch(function (err, ref) {
        if (err) return callback(err);
        return db.write(ref, hash + "\n", function (err) {
          if (err) return callback(err);
          if (trace) trace("update-head", null, ref + " " + hash);
          callback();
        });
      });
    }

    function getBranch(callback) {
      if (!callback) return getBranch.bind(this);
      return db.read("HEAD", function (err, ref) {
        if (err) return callback(err);
        if (!ref) return callback(new Error("Missing HEAD"));
        var match = ref.match(/^ref: *(.*)/);
        if (!match) return callback(new Error("Invalid HEAD"));
        return callback(null, match[1]);
      });
    }

    function setBranch(branchName, callback) {
      if (!callback) return setBranch.bind(this, branchName);
      var ref = "refs/heads/" + branchName;
      return db.write("HEAD", "ref: " + ref + "\n", function (err) {
        if (err) return callback(err);
        if (trace) trace("set-branch", null, ref);
        callback();
      });
    }

    function createBranch(branchName, hash, callback) {
      if (!callback) return createBranch.bind(this, branchName, hash);
      return createThing("refs/heads/", branchName, hash, callback);
    }

    function createTag(tagName, hash, callback) {
      if (!callback) return createTag.bind(this, tagName, hash);
      return createThing("refs/tags/", tagName, hash, callback);
    }

    function createThing(prefix, name, hash, callback) {
      return db.write(prefix + name, hash + "\n", callback);
    }

    function deleteBranch(branchName, callback) {
      if (!callback) return deleteBranch.bind(this, branchName);
      return deleteThing("refs/heads/", branchName, callback);
    }

    function deleteTag(tagName, callback) {
      if (!callback) return deleteTag.bind(this, tagName);
      return deleteThing("refs/tags/", tagName, callback);
    }

    function deleteThing(prefix, name, callback) {
      return db.unlink(prefix + name, callback);
    }

    function listBranches(callback) {
      if (!callback) return listBranches.bind(this);
      return listThings("refs/heads", function (err, refs) {
        if (err) return callback(err);
        var branches = {};
        for (var key in refs) {
          branches[key.substr(11)] = refs[key];
        }
        callback(null, branches);
      });
    }

    function listTags(callback) {
      if (!callback) return listTags.bind(this);
      return listThings("refs/tags", function (err, refs) {
        if (err) return callback(err);
        var branches = {};
        for (var key in refs) {
          branches[key.substr(10)] = refs[key];
        }
        callback(null, branches);
      });
    }

    function listRefs(callback) {
      if (!callback) return listRefs.bind(this);
      return listThings("refs", callback);
    }

    function listThings(prefix, callback) {
      var branches = {};
      return loadDir(prefix, function (err) {
        if (err) return callback(err);
        callback(null, branches);
      });

      function loadDir(dir, callback) {
        var list = [];

        return db.readdir(dir, function (err, names) {
          if (err) {
            if (err.code === "ENOENT") return callback();
            return callback(err);
          }
          list = new Array(names.length);
          for (var i = 0, l = names.length; i < l; ++i) {
            list[i] = dir + "/" + names[i];
          }
          return shift();
        });
        function shift(err) {
          if (err) return callback(err);
          var target = list.shift();
          if (!target) return callback();
          return db.read(target, function (err, hash) {
            if (err) {
              if (err.code === "EISDIR") return loadDir(target, shift);
              return callback(err);
            }
            if (hash) {
              branches[target] = hash.trim();
              return shift();
            }
            return loadDir(target, shift);
          });
        }
      }
    }

    function indexOf(buffer, byte, i) {
      i |= 0;
      var length = buffer.length;
      for (;;i++) {
        if (i >= length) return -1;
        if (buffer[i] === byte) return i;
      }
    }

    function parseAscii(buffer, start, end) {
      var val = "";
      while (start < end) {
        val += String.fromCharCode(buffer[start++]);
      }
      return val;
    }

    function parseDec(buffer, start, end) {
      var val = 0;
      while (start < end) {
        val = val * 10 + buffer[start++] - 0x30;
      }
      return val;
    }

    function parseOct(buffer, start, end) {
      var val = 0;
      while (start < end) {
        val = (val << 3) + buffer[start++] - 0x30;
      }
      return val;
    }

    function deframe(buffer) {
      var space = indexOf(buffer, 0x20);
      if (space < 0) throw new Error("Invalid git object buffer");
      var nil = indexOf(buffer, 0x00, space);
      if (nil < 0) throw new Error("Invalid git object buffer");
      var body = bops.subarray(buffer, nil + 1);
      var size = parseDec(buffer, space + 1, nil);
      if (size !== body.length) throw new Error("Invalid body length.");
      return [
        parseAscii(buffer, 0, space),
        body
      ];
    }

    function frame(type, body) {
      return bops.join([
        bops.from(type + " " + body.length + "\0"),
        body
      ]);
    }

    // A sequence of bytes not containing the ASCII character byte
    // values NUL (0x00), LF (0x0a), '<' (0c3c), or '>' (0x3e).
    // The sequence may not begin or end with any bytes with the
    // following ASCII character byte values: SPACE (0x20),
    // '.' (0x2e), ',' (0x2c), ':' (0x3a), ';' (0x3b), '<' (0x3c),
    // '>' (0x3e), '"' (0x22), "'" (0x27).
    function safe(string) {
      return string.replace(/(?:^[\.,:;<>"']+|[\0\n<>]+|[\.,:;<>"']+$)/gm, "");
    }

    function formatDate(date) {
      var timezone = (date.timeZoneoffset || date.getTimezoneOffset()) / 60;
      var seconds = Math.floor(date.getTime() / 1000);
      return seconds + " " + (timezone > 0 ? "-0" : "0") + timezone + "00";
    }

    function encodePerson(person) {
      if (!person.name || !person.email) {
        throw new TypeError("Name and email are required for person fields");
      }
      return safe(person.name) +
        " <" + safe(person.email) + "> " +
        formatDate(person.date || new Date());
    }

    function encodeCommit(commit) {
      if (!commit.tree || !commit.author || !commit.message) {
        throw new TypeError("Tree, author, and message are require for commits");
      }
      var parents = commit.parents || (commit.parent ? [ commit.parent ] : []);
      if (!Array.isArray(parents)) {
        throw new TypeError("Parents must be an array");
      }
      var str = "tree " + commit.tree;
      for (var i = 0, l = parents.length; i < l; ++i) {
        str += "\nparent " + parents[i];
      }
      str += "\nauthor " + encodePerson(commit.author) +
             "\ncommitter " + encodePerson(commit.committer || commit.author) +
             "\n\n" + commit.message;
      return bops.from(str);
    }

    function encodeTag(tag) {
      if (!tag.object || !tag.type || !tag.tag || !tag.tagger || !tag.message) {
        throw new TypeError("Object, type, tag, tagger, and message required");
      }
      var str = "object " + tag.object +
        "\ntype " + tag.type +
        "\ntag " + tag.tag +
        "\ntagger " + encodePerson(tag.tagger) +
        "\n\n" + tag.message;
      return bops.from(str + "\n" + tag.message);
    }

    function pathCmp(a, b) {
      a += "/"; b += "/";
      return a < b ? -1 : a > b ? 1 : 0;
    }

    function encodeTree(tree) {
      var chunks = [];
      Object.keys(tree).sort(pathCmp).forEach(function (name) {
        var entry = tree[name];
        chunks.push(
          bops.from(entry.mode.toString(8) + " " + name + "\0"),
          bops.from(entry.hash, "hex")
        );
      });
      return bops.join(chunks);
    }

    function encodeBlob(blob) {
      if (bops.is(blob)) return blob;
      return bops.from(blob);
    }

    function decodePerson(string) {
      var match = string.match(/^([^<]*) <([^>]*)> ([^ ]*) (.*)$/);
      if (!match) throw new Error("Improperly formatted person string");
      var sec = parseInt(match[3], 10);
      var date = new Date(sec * 1000);
      date.timeZoneoffset = parseInt(match[4], 10) / 100 * -60;
      return {
        name: match[1],
        email: match[2],
        date: date
      };
    }


    function decodeCommit(body) {
      var i = 0;
      var start;
      var key;
      var parents = [];
      var commit = {
        tree: "",
        parents: parents,
        author: "",
        committer: "",
        message: ""
      };
      while (body[i] !== 0x0a) {
        start = i;
        i = indexOf(body, 0x20, start);
        if (i < 0) throw new SyntaxError("Missing space");
        key = parseAscii(body, start, i++);
        start = i;
        i = indexOf(body, 0x0a, start);
        if (i < 0) throw new SyntaxError("Missing linefeed");
        var value = bops.to(bops.subarray(body, start, i++));
        if (key === "parent") {
          parents.push(value);
        }
        else {
          if (key === "author" || key === "committer") {
            value = decodePerson(value);
          }
          commit[key] = value;
        }
      }
      i++;
      commit.message = bops.to(bops.subarray(body, i));
      return commit;
    }

    function decodeTag(body) {
      var i = 0;
      var start;
      var key;
      var tag = {};
      while (body[i] !== 0x0a) {
        start = i;
        i = indexOf(body, 0x20, start);
        if (i < 0) throw new SyntaxError("Missing space");
        key = parseAscii(body, start, i++);
        start = i;
        i = indexOf(body, 0x0a, start);
        if (i < 0) throw new SyntaxError("Missing linefeed");
        var value = bops.to(bops.subarray(body, start, i++));
        if (key === "tagger") value = decodePerson(value);
        tag[key] = value;
      }
      i++;
      tag.message = bops.to(bops.subarray(body, i));
      return tag;
    }

    function decodeTree(body) {
      var i = 0;
      var length = body.length;
      var start;
      var mode;
      var name;
      var hash;
      var tree = [];
      while (i < length) {
        start = i;
        i = indexOf(body, 0x20, start);
        if (i < 0) throw new SyntaxError("Missing space");
        mode = parseOct(body, start, i++);
        start = i;
        i = indexOf(body, 0x00, start);
        name = bops.to(bops.subarray(body, start, i++));
        hash = bops.to(bops.subarray(body, i, i += 20), "hex");
        tree.push({
          mode: mode,
          name: name,
          hash: hash
        });
      }
      return tree;
    }

    function decodeBlob(body) {
      return body;
    }

    function lsRemote(remote, callback) {
      if (!callback) return lsRemote.bind(this, remote);
      remote.discover(function (err, refs) {
        if (err) return callback(err);
        remote.close(function (err) {
          if (err) return callback(err);
          callback(null, refs);
        });
      });
    }

    function fetch(remote, opts, callback) {
      if (!callback) return fetch.bind(this, remote, opts);
      return remote.discover(function (err, refs, serverCaps) {
        if (err) return callback(err);
        var caps = processCaps(opts, serverCaps);
        return processWants(refs, opts.want, function (err, wants) {
          if (err) return callback(err);
          opts.caps = caps;
          opts.wants = wants;
          return remote.fetch(repo, opts, function (err, packStream) {
            if (err) return callback(err);
            return unpack(packStream, opts, function (err) {
              if (err) return callback(err);
              return remote.close(callback);
            });
          });
        });
      });
    }

    function processCaps(opts, serverCaps) {
      var caps = [];
      if (serverCaps["ofs-delta"]) caps.push("ofs-delta");
      if (serverCaps["thin-pack"]) caps.push("thin-pack");
      if (opts.includeTag && serverCaps["include-tag"]) caps.push("include-tag");
      if ((opts.onProgress || opts.onError) &&
          (serverCaps["side-band-64k"] || serverCaps["side-band"])) {
        caps.push(serverCaps["side-band-64k"] ? "side-band-64k" : "side-band");
        if (!opts.onProgress && serverCaps["no-progress"]) {
          caps.push("no-progress");
        }
      }
      if (serverCaps.agent) caps.push("agent=" + platform.agent);
      return caps;
    }

    // Possible values for `filter`
    // "HEAD" - fetch whatever the remote head is
    // "refs/heads/master - ref
    // ["refs/heads/master"] - list of refs
    // "master" - branch
    // ["master"] - list of branches
    // "0.0.1" - tag
    // ["0.0.1"] - list of tags
    // function (ref, callback) { callback(null, true); } - interactive
    // true - Fetch all remote refs.
    function processWants(refs, filter, callback) {
      if (filter === null || filter === undefined) {
        return defaultWants(refs, callback);
      }
      filter = Array.isArray(filter) ? arrayFilter(filter) :
        typeof filter === "function" ? filter = filter :
        wantFilter(filter);

      var list = Object.keys(refs);
      var wants = {};
      var ref, hash;
      return shift();
      function shift() {
        ref = list.shift();
        if (!ref) return callback(null, Object.keys(wants));
        hash = refs[ref];
        resolveHashish(ref, onResolve);
      }
      function onResolve(err, oldHash) {
        // Skip refs we already have
        if (hash === oldHash) return shift();
        filter(ref, onFilter);
      }
      function onFilter(err, want) {
        if (err) return callback(err);
        // Skip refs the user doesn't want
        if (want) wants[hash] = true;
        return shift();
      }
    }

    function defaultWants(refs, callback) {
      // TODO: add in local refs for auto updates.
      return processWants(refs, "HEAD", callback);
    }

    function wantMatch(ref, want) {
      if (want === "HEAD" || want === null || want === undefined) {
        return ref === "HEAD";
      }
      if (Object.prototype.toString.call(want) === '[object RegExp]') {
        return want.test(ref);
      }
      if (typeof want === "boolean") return want;
      if (typeof want !== "string") {
        throw new TypeError("Invalid want type: " + typeof want);
      }
      return (/^refs\//.test(ref) && ref === want) ||
        (ref === "refs/heads/" + want) ||
        (ref === "refs/tags/" + want);
    }

    function wantFilter(want) {
      return function (ref, callback) {
        var result;
        try {
          result = wantMatch(ref, want);
        }
        catch (err) {
          return callback(err);
        }
        return callback(null, result);
      };
    }

    function arrayFilter(want) {
      var length = want.length;
      return function (ref, callback) {
        var result;
        try {
          for (var i = 0; i < length; ++i) {
            if (result = wantMatch(ref, want[i])) break;
          }
        }
        catch (err) {
          return callback(err);
        }
        return callback(null, result);
      };
    }

    function push() {
      throw new Error("TODO: Implement repo.fetch");
    }

    function unpack(packStream, opts, callback) {
      if (!callback) return unpack.bind(this, packStream, opts);
      // TODO: save the stream to the local repo.
      var version, num, count = 0, deltas = 0;

      // hashes keyed by offset
      var hashes = {};
      var seen = {};
      var toDelete = {};
      var pending = {};
      var queue = [];

      packStream.read(function (err, stats) {
        if (err) return callback(err);
        version = stats.version;
        num = stats.num;
        packStream.read(onRead);
      });
      function onRead(err, item) {
        if (err) return callback(err);
        if (opts.onProgress) {
          var percent = Math.round(count / num * 100);
          opts.onProgress("Receiving objects: " + percent + "% (" + count + "/" + num + ")   " + (item ? "\r" : "\n"));
          count++;
        }
        if (item === undefined) {
          hashes = null;
          count = 0;
          return checkExisting();
        }
        if (item.size !== item.body.length) {
          return callback(new Error("Body size mismatch"));
        }
        var buffer = bops.join([
          bops.from(item.type + " " + item.size + "\0"),
          item.body
        ]);
        var hash = sha1(buffer);
        hashes[item.offset] = hash;
        var ref = item.ref;
        if (ref) {
          deltas++;
          if (item.type === "ofs-delta") {
            ref = hashes[item.offset - ref];
          }
          var list = pending[ref];
          if (list) list.push(hash);
          else pending[ref] = [hash];
          toDelete[hash] = true;
        }
        else {
          seen[hash] = true;
        }

        db.save(hash, buffer, function (err) {
          if (err) return callback(err);
          if (trace) trace("save", null, hash);
          packStream.read(onRead);
        });
      }

      function checkExisting() {
        var list = Object.keys(pending);
        var hash;
        return pop();
        function pop() {
          hash = list.pop();
          if (!hash) return applyDeltas();
          return db.has(hash, onHas);
        }
        function onHas(err, has) {
          if (err) return callback(err);
          if (has) seen[hash] = true;
          return pop();
        }
      }

      function applyDeltas() {
        Object.keys(pending).forEach(function (ref) {
          if (seen[ref]) {
            pending[ref].forEach(function (hash) {
              queue.push({hash:hash,ref:ref});
            });
            delete pending[ref];
          }
        });
        return queue.length ? check() : cleanup();
      }

      function deltaProgress() {
        var percent = Math.round(count / deltas * 100);
        return "Applying deltas: " + percent + "% (" + count++ + "/" + deltas + ")   ";
      }

      function check() {
        var item = queue.pop();
        if (!item) return applyDeltas();
        if (opts.onProgress) {
          opts.onProgress(deltaProgress() + "\r");
        }
        db.load(item.ref, function (err, target) {
          if (err) return callback(err);
          db.load(item.hash, function (err, delta) {
            if (err) return callback(err);
            target = deframe(target);
            delta = deframe(delta);
            var buffer = frame(target[0], applyDelta(delta[1], target[1]));
            var hash = sha1(buffer);
            db.save(hash, buffer, function (err) {
              if (err) return callback(err);
              var deps = pending[item.hash];
              if (deps) {
                pending[hash] = deps;
                delete pending[item.hash];
              }
              seen[hash] = true;
              return check();
            });
          });
        });
      }

      function cleanup() {
        if (opts.onProgress) {
          opts.onProgress(deltaProgress() + "\n");
        }
        var hashes = Object.keys(toDelete);
        next();
        function next(err) {
          if (err) return callback(err);
          var hash = hashes.pop();
          if (!hash) return done();
          db.remove(hash, next);
        }
      }

      function done() {

      }

    }

  }

};