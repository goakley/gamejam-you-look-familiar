/******************************************************************************
 * Copyright (c) 2014 "Glen Oakley"
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 *****************************************************************************/


/* HELPER FUNCTIONS */

/* Assert pops us an alert if the condition fails */
function assert(condition, message) {
    if (!condition) {
        alert("ASSERSION FAILED!\n" + (message || ""));
        throw "Assertion failed: " + (message || "Failed to assert condition");
    }
}

/* Interpolates between two numbers based on a ratio */
function interpolate(start, end, ratio) {
    if (ratio < 0.0) ratio = 0.0;
    if (ratio > 1.0) ratio = 1.0;
    if (typeof start === "object") {
        // interpolate all array elements
        var result = [];
        for (var i = 0; i < start.length; i++)
            result.push(end[i] * ratio + start[i] * (1.0-ratio));
        return result;
    }
    // interpolate the two values
    return end * ratio + start * (1.0-ratio);
}

/* Converts RGB float values (0.0 - 1.0) to an 'rgb()' string */
function rgbfloats(r, g, b) {
    if (typeof r === "object")
        // apply to three-element RGB array
        return "rgb(" + (r[0]*255<<0) + "," + (r[1]*255<<0) + "," + (r[2]*255<<0) + ")";
    // apply to red, green, and blue
    return "rgb(" + (r*255<<0) + "," + (g*255<<0) + "," + (b*255<<0) + ")";
}

/* Generates contour points between 0.0 and 1.0 */
function generate_contour(granularity, rough) {
    if (!granularity)
        granularity = 0.1;
    if (!rough)
        rough = 1.1;
    const ROUGHNESS = Math.pow(2, -rough); // play with the exponent!
    return (function segment(x0, y0, x1, y1, rancap) {
        if (x1 - x0 < granularity)
            return [y0, y1];
        var midX = (x1 + x0) / 2,
            midY = (y1 + y0) / 2;
        midY += (Math.random() - 0.5) * rancap;
        if (midY < 0.1) midY = 0.1;
        if (midY > 0.9) midY = 0.9;
        var left = segment(x0, y0, midX, midY, rancap * ROUGHNESS),
            right = segment(midX, midY, x1, y1, rancap * ROUGHNESS);
        left.pop(); // left[-1] === right[0]
        return left.concat(right);
    })(0.0, 0.5, 1.0, 0.5, 1.0);
}


/* Wrap the entire game in a closure, because reasons */

(function() {
    /* GAME DATA */

    /* The circumference of the game world, in pixels */
    const CIRCUMFERENCE = 2000;
    /* The render delay, in milliseconds (entity interpolation) */
    const INTERPOLATION = 150;
    /* The time at which the game starts, unix */
    const STARTTIME = (new Date()).getTime();
    /* The milliseconds it takes to let the world naturalize */
    const TIMEWORLD = 30000;

    /* Handle the audio for the game */
    // (Audio.loop seems to be not implemented, so we've hacked it, bigtime)
    // (because onended seems to have shaky results also)
    (function play_waves() {
        window.setTimeout(play_waves, 12000);
        var audio = new Audio("waves.ogg");
        audio.addEventListener("canplay", function(){this.play();});
        audio = null;
    })();

    /* Load up the rendering context */
    var canvas = document.getElementById("game"),
        context = canvas.getContext('2d');
    canvas.width = document.body.clientWidth;
    canvas.height = document.body.clientHeight;
    window.addEventListener('resize', function() {
        canvas.width = document.body.clientWidth;
        canvas.height = document.body.clientHeight;
    });
    canvas.focus();

    /* The world data, specific to this game instance */
    var world = (function() {
        var world = {}, i;
        // generate the grass elements
        world.grass = [];
        for (i = 0; i < (CIRCUMFERENCE/100); i++)
            world.grass.push(Math.random(),Math.random());
        world.colours = [];
        for (i = 0; i < 6; i++)
            world.colours.push(Math.random());
        var hillpoints = generate_contour(10/CIRCUMFERENCE);
        world.hillpoints = hillpoints.slice();
        world.hillpoints.pop();
        hillpoints.reverse();
        world.hillpoints.concat(hillpoints);
        return world;
    })();
    console.log(world.hillpoints.length);

    /* The local client player */
    var player = (function() {
        var player = {}, i;
        player.id = Math.random().toString().substr(2);
        player.colours = [];
        for (i = 0; i < 3; i++)
            player.colours.push(Math.random());
        player.inflections = generate_contour(0.1);
        player.position = Math.random()-0.5;
        return player;
    })();

    /* All of the players (including the local player), filled and managed by the
     * network code (table by player ID) */
    var players = {};

    /* The movement status of the local player based on input:
     * 0 for stationary, -1 for left, +1 for right */
    var moving = 0;


    /* NETWORKING LOGIC (THROUGH FIREBASE) */

    /* Connect to the player data */
    var firebase = new Firebase("http://globalgamejam14.firebaseio.com/players");
    firebase.on("child_added", function(snapshot, _) {
        snapshot = snapshot.val();
        players[snapshot.id] = {
            colours: snapshot.colours,
            inflections: snapshot.inflections,
            positions: [{stime: snapshot.stime, pos: snapshot.pos}],
            starttime: (new Date()).getTime(),
            ratio: 0.0
        };
    });
    firebase.on("child_changed", function(snapshot, _) {
        snapshot = snapshot.val();
        if (!players[snapshot.id])
            players[snapshot.id] = {
                colours: snapshot.colours,
                inflections: snapshot.inflections,
                positions: [],
                starttime: (new Date()).getTime(),
                ratio: 0.0
            };
        players[snapshot.id].positions.push({stime: snapshot.stime, pos: snapshot.pos});
    });
    firebase.on("child_removed", function(snapshot) {
        delete players[snapshot.val().id];
    });

    /* Reference the local player directly */
    var firebasep = new Firebase("http://globalgamejam14.firebaseio.com/players/" + player.id);
    /* Remove the local player when they disconnect */
    firebasep.onDisconnect().remove();
    /* Install the local player data to the server */
    firebasep.set({
        id: player.id,
        colours: player.colours,
        inflections: player.inflections,
        stime: Firebase.ServerValue.TIMESTAMP,
        pos: player.position
    });

    /* The approximate local/server time offset from the server */
    var offset = 0;
    /* Updates the local/server time offset */
    (new Firebase("http://globalgamejam14.firebaseio.com/.info/serverTimeOffset")).on("value", function(snapshot) {
        offset = snapshot.val();
    });


    /* USER INPUT */

    canvas.addEventListener('keydown', function(e) {
        switch(e.keyCode) {
        case 37: // <--
        case 65: // 'A'
        case 97: // 'a'
            moving = -1; // 'left'
            break;
        case 39: // -->
        case 68: // 'D'
        case 100: // 'd'
            moving = 1; // 'right'
            break;
        case 32: // SPACE - debug key
            console.log(fps);
            break;
        }
    });
    canvas.addEventListener('keyup', function(e) {
        switch(e.keyCode) {
        case 37: // <--
        case 65: // 'A'
        case 97: // 'a'
            if (moving === -1)
                moving = 0;
            break;
        case 39: // -->
        case 68: // 'D'
        case 100: // 'd'
            if (moving === 1)
                moving = 0;
            break;
        }
    });


    /* RENDERING LOGIC */

    /* Draws grass centered at some location with some %offset
     * in front of or behind the player */
    function draw_grass(xcenter, distance, behind) {
        if (distance > 0.5 && behind)
            return;
        if (distance <= 0.5 && !behind)
            return;
        var offset = (distance*8)<<0;
        context.beginPath();
        context.moveTo(xcenter-4, 2 * canvas.height / 3 + offset);
        context.lineTo(xcenter-10, 2 * canvas.height / 3 - 6 + offset);
        context.lineTo(xcenter-4, 2 * canvas.height / 3 - 4 + offset);
        context.lineTo(xcenter+0, 2 * canvas.height / 3 - 12 + offset);
        context.lineTo(xcenter+4, 2 * canvas.height / 3 - 4 + offset);
        context.lineTo(xcenter+10, 2 * canvas.height / 3 - 6 + offset);
        context.lineTo(xcenter+4, 2 * canvas.height / 3 + offset);
        context.fill();
        context.stroke();
    }

    function draw_backhills(hills, xcenter, ratio) {
        context.strokeStyle = "#000000";
        context.fillStyle = rgbfloats(interpolate(player.colours, world.colours.slice(3,6), ratio));
        context.beginPath();
        context.moveTo(xcenter-CIRCUMFERENCE, 3 * canvas.height / 4);
        for (var i = 0; i < hills.length; i++)
            context.lineTo(xcenter - CIRCUMFERENCE + CIRCUMFERENCE * (i / (hills.length - 1)),
                           canvas.height / 2 + hills[i] * (canvas.height / 4));
        for (i = 1; i < hills.length; i++)
            context.lineTo(xcenter + CIRCUMFERENCE * (i / (hills.length - 1)),
                           canvas.height / 2 + hills[i] * (canvas.height / 4));
        context.lineTo(xcenter + CIRCUMFERENCE, 3 * canvas.height / 4);
        context.closePath();
        context.fill();
        context.stroke();
    }

    /* Draws a player (target) with a certain conversion ratio */
    function draw_player(target, xcenter, ratio) {
        var colours = interpolate(player.colours, target.colours, ratio);
        context.fillStyle = rgbfloats(colours);
        context.strokeStyle = "#000000";
        var inflections = interpolate(player.inflections, target.inflections, ratio);
        const start = -30, end = 30, distance = end - start;
        context.beginPath();
        context.moveTo(xcenter - 40, 2 * canvas.height / 3 + 4);
        for (var i = 0; i < inflections.length; i++) {
            context.lineTo(xcenter + start + distance * (i / (inflections.length - 1)),
                           2 * canvas.height / 3 - 80 + inflections[i] * 40);
        }
        context.lineTo(xcenter + 40, 2 * canvas.height / 3 + 4);
        context.closePath();
        context.fill();
        context.stroke();
    }

    function render() {
        var time = (new Date()).getTime();
        var itime = time + offset - INTERPOLATION;
        var ptime = (time - STARTTIME) / TIMEWORLD;
        var playerp = CIRCUMFERENCE * player.position;
        // clear the screen
        context.fillStyle = "#f0f0ff";
        context.fillRect(0,0,canvas.width,canvas.height);
        // render the back hills
        draw_backhills(world.hillpoints, canvas.width / 2 - playerp, ptime);
        // render the ground
        context.fillStyle = rgbfloats(interpolate(player.colours, world.colours, ptime));
        context.fillRect(0, canvas.height * 2 / 3, canvas.width, canvas.height / 3);
        context.strokeRect(0, canvas.height * 2 / 3, canvas.width, canvas.height / 3);
        // render the grass behind
        for (var i = 0; i < world.grass.length; i+=2) {
            var xp = CIRCUMFERENCE * world.grass[i] + canvas.width / 2 - playerp;
            draw_grass(xp, world.grass[i+1], true);
            xp = CIRCUMFERENCE * (world.grass[i]-1.0) + canvas.width / 2 - playerp;
            draw_grass(xp, world.grass[i+1], true);
        }
        // render the other players
        for (var other in players) {
            while (players[other].positions.length > 1 && players[other].positions[1]["stime"] < itime) {
                players[other].positions.splice(0,1);
            }
            if (other === player.id)
                continue;
            var position = 0.0;
            assert(players[other].positions.length > 0);
            if (players[other].positions.length === 1) {
                position = players[other].positions[0]["pos"];
            }
            else {
                var timepassed = itime - players[other].positions[0]["stime"];
                var timeall = players[other].positions[1]["stime"] - players[other].positions[0]["stime"];
                var ratio = timepassed / timeall;
                position = interpolate(players[other].positions[0]["pos"], players[other].positions[1]["pos"], ratio);
            }
            context.fillStyle = rgbfloats(players[other].colours);
            context.strokeStyle = "#000000";
            var xp = CIRCUMFERENCE * position + canvas.width / 2 - playerp;
            draw_player(players[other], xp, players[other].ratio);//(time-players[other].starttime) / TIMEWORLD);
            if (position < 0) position += 1.0;
            else position -= 1.0;
            xp = CIRCUMFERENCE * position + canvas.width / 2 - playerp;
            draw_player(players[other], xp, players[other].ratio);//(time-players[other].starttime) / TIMEWORLD);
        }
        // render the player
        context.fillStyle = rgbfloats(player.colours);
        context.strokeStyle = "#000000";
        draw_player(player, canvas.width / 2, 0.0);
        // render the grass in front
        context.fillStyle = rgbfloats(interpolate(player.colours, world.colours, ptime));
        for (var i = 0; i < world.grass.length; i+=2) {
            var xp = CIRCUMFERENCE * world.grass[i] + canvas.width / 2 - playerp;
            draw_grass(xp, world.grass[i+1], false);
            xp = CIRCUMFERENCE * (world.grass[i]-1.0) + canvas.width / 2 - playerp;
            draw_grass(xp, world.grass[i+1], false);
        }
    }


    /* UPDATE LOGIC */

    function update() {
        // update position
        if (moving) {
            player.position += moving * 2 / CIRCUMFERENCE;
            firebasep.update({
                stime: Firebase.ServerValue.TIMESTAMP,
                pos: player.position
            });
            if (player.position < -0.5)
                player.position += 1.0;
            if (player.position > 0.5)
                player.position -= 1.0;
        }
        // update players
        var time = (new Date()).getTime();
        var itime = time + offset - INTERPOLATION;
        for (var other in players) {
            // update other player positions by clearing out old entries
            while (players[other].positions.length > 1 && players[other].positions[1]["stime"] < itime) {
                players[other].positions.splice(0,1);
            }
            // get the other player's position
            var position = 0.0;
            assert(players[other].positions.length > 0);
            if (players[other].positions.length === 1) {
                position = players[other].positions[0]["pos"];
            }
            else {
                var timepassed = itime - players[other].positions[0]["stime"];
                var timeall = players[other].positions[1]["stime"] - players[other].positions[0]["stime"];
                var ratio = timepassed / timeall;
                position = interpolate(players[other].positions[0]["pos"], players[other].positions[1]["pos"], ratio);
            }
            // update the ratio
            var ps = [
                Math.abs(position - player.position),
                Math.abs((position+1) - player.position),
                Math.abs((position-1) - player.position),
                Math.abs(position - player.position),
                Math.abs(position - (player.position+1)),
                Math.abs(position - (player.position-1))
            ];
            var distance = Math.abs(Math.min.apply(null, ps) * CIRCUMFERENCE);
            if (distance < canvas.width / 10)
                players[other].ratio += 0.002;
            if (distance < canvas.width / 5)
                players[other].ratio += 0.001;
            if (distance < canvas.width / 3)
                players[other].ratio += 0.0001;
            else if (distance < canvas.width / 2)
                players[other].ratio -= 0.001;
            else
                players[other].ratio -= 0.002;
            if (players[other].ratio < 0.0)
                players[other].ratio = 0.0;
            if (players[other].ratio > 1.0)
                players[other].ratio = 1.0;
        }
    }


    /* GAME LOOP */

    var lastCalledTime;
    var fps;
    (function gameloop() {
        window.requestAnimationFrame(gameloop);
        if (!lastCalledTime) {
            lastCalledTime = (new Date()).getTime();
            fps = 0;
            return;
        }
        delta = ((new Date).getTime() - lastCalledTime)/1000;
        lastCalledTime = (new Date()).getTime();
        fps = 1/delta;
        update();
        render();
    })();
})();
