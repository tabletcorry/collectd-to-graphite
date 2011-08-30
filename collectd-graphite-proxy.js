/* TODO(sissel): make connections retry/etc 
 * TODO(sissel): make graphite target configurable via command line
 *
 * This code is a work in progress.
 *
 * To use this, put the following in your collectd config:
 *
 * LoadPlugin write_http
 * <Plugin write_http>
 *   <URL "http://monitor:3012/post-collectd">
 *   </URL>
 * </Plugin>
 *
 * This will make collectd write 'PUTVAL' statements over HTTP to the above URL.
 * This code below will then convert the PUTVAL statements to graphite metrics
 * and ship them to 'monitor:2003'
 */
var http = require("http");
var net = require("net");
var assert = require("assert");
var fs = require('fs');

var types = fs.readFileSync('/usr/share/collectd/types.db', encoding='utf8').split("\n");

var typesObj = new Object;

var type_comments_re = /^#/;
var type_cut_re = /^([^\s]+)\s+(.*)/;

for (var i in types) {
  if (!type_comments_re.exec(types[i])) {
    typeSet = type_cut_re.exec(types[i])
    if (!typeSet) { continue; }
    for (var t=0;t < typeSet.length;t++) {
      var name = typeSet[1];
      typesObj[name] = new Array();
      var eachType = typeSet[2].split(", ")
      for (var u=0; u < eachType.length; u++){
        var theName = eachType[u].split(":")[0];
        typesObj[name].push(theName);
      }
    }
  }
}


try {
  var graphite_connection = net.createConnection(2003, host=process.argv[2]);
} catch (error) {
  throw error;
}
graphite_connection.on("close", function() {
  throw new Error("Connection closed");
});
graphite_connection.on("error", function() {
  throw new Error("Connection error");
});

var fragment = ""

var request_handler = function(request, response) {
  var putval_re = /^PUTVAL ([^ ]+)(?: ([^ ]+=[^ ]+)?) ([0-9.]+)(:.*)/;
  request.addListener("data", function(chunk) {
    metrics = chunk.toString().split("\r\n");

    if ( fragment.length > 0 ) {
      // Discard the fragment if the new line is well formed
      //  I have never seen this, but it may be possible
      if ( String(metrics[0]).indexOf("PUTVAL") < 0 ) {
        metrics[0] = fragment.concat(metrics[0])
      }
      fragment = ""
    }
    // If the last line is not empty, then this chunk is likely split
    //  in two. So, we will store the fragment for the next round
    //  The fragment is not used in this run, as it is corrupted and may
    //  actaully pass the regex (and mess up the DB)
    if ( String(metrics[metrics.length-1]).length != 0 ) {
      fragment = metrics[metrics.length-1]
      metrics[metrics.length-1] = ""
    }

    for (var i=0; i<metrics.length; i++) {
      var m = putval_re.exec(metrics[i]);
      if (!m) {
        continue;
      }
      var values = m[4].split(":");

      for (var v in values) {
        
        var name = m[1];
        var options = m[2];
        var time = m[3];

        if ( v == 0 ) {
          continue;
        }

        // Replace some chars for graphite, split into parts
        var name_parts = name.replace(/\./g, "_").replace(/\//g, ".").split(".");

        // Start to construct the new name
        var rebuild = ["hosts"]

        // Strip off the domain name of the host
        var host = name_parts[0].split(/_/)[0]
        rebuild = rebuild.concat(host)

        // Pluigin names can contain an "instance" which is set apart by a dash
        var plugin = name_parts[1].split("-")
        rebuild = rebuild.concat(plugin[0])
        if (plugin.length > 1) {
          var plugin_instance = plugin.slice(1).join("-")
          rebuild = rebuild.concat(plugin_instance)
        }
        plugin = plugin[0]

        // Type names can also contain an "instance"
        var type = name_parts[2].split("-")
        if (type[0] != plugin) {
          // If type and plugin are equal, delete one to clean up a bit
          rebuild = rebuild.concat(type[0])
        }
        if (type.length > 1) {
          var type_instance = type.slice(1).join("-")
          rebuild = rebuild.concat(type_instance)
        }
        type = type[0]

        // Put the name back together
        name = rebuild.join(".")
        
        if ( values.length > 2 ) {
          var metric = name_parts[2];

          //  If the metric contains a '-' (after removing the instance name)
          //  then we want to remove it before looking up in the types.db
          index = metric.search(/-/)
          if (index > -1) {
            metric = /^([\w]+)-(.*)$/.exec(metric);
          } else {
            // Kinda a hack
            metric = [ "", metric]
          }
          name = name + "." + typesObj[metric[1]][v - 1];
        }
        message = [name, values[v], time].join(" ");
        graphite_connection.write(message + "\n");

      }

    }
  });

  request.addListener("end", function() {
    response.writeHead(200, {"Content-Type": "text/plain"});
    response.write("OK");
    response.end();
  });
}

var server = http.createServer()
server.addListener("request", request_handler)
server.listen(3012);
