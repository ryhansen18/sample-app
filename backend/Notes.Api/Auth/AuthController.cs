using System.Security.Claims;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;

using Notes.Api.Domain;

namespace Notes.Api.Auth;

[ApiController]
[Route("api/[controller]")]
public sealed class AuthController(
    UserManager<ApplicationUser> userManager,
    IJwtTokenService tokens) : ControllerBase
{
    [HttpPost("register")]
    [ProducesResponseType<AuthResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType<ValidationProblemDetails>(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<AuthResponse>> Register(RegisterRequest request, CancellationToken ct)
    {
        var user = new ApplicationUser
        {
            UserName = request.Email,
            Email = request.Email
        };

        var result = await userManager.CreateAsync(user, request.Password);
        if (!result.Succeeded)
        {
            var errors = new Dictionary<string, string[]>();
            foreach (var err in result.Errors)
            {
                var key = err.Code switch
                {
                    "DuplicateUserName" or "DuplicateEmail" or "InvalidEmail" => nameof(RegisterRequest.Email),
                    var c when c.StartsWith("Password", StringComparison.Ordinal) => nameof(RegisterRequest.Password),
                    _ => ""
                };

                errors[key] = !errors.TryGetValue(key, out var existing)
                    ? new[] { err.Description }
                    : existing.Append(err.Description).ToArray();
            }

            return ValidationProblem(new ValidationProblemDetails(errors));
        }

        return Ok(tokens.Issue(user));
    }

    [HttpPost("login")]
    [ProducesResponseType<AuthResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<AuthResponse>> Login(LoginRequest request, CancellationToken ct)
    {
        var user = await userManager.FindByEmailAsync(request.Email);
        if (user is null || !await userManager.CheckPasswordAsync(user, request.Password))
        {
            return Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Invalid credentials");
        }

        return Ok(tokens.Issue(user));
    }

    [Authorize]
    [HttpGet("me")]
    [ProducesResponseType<UserDto>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public ActionResult<UserDto> Me()
    {
        var id = User.FindFirstValue(ClaimTypes.NameIdentifier);
        var email = User.FindFirstValue(ClaimTypes.Email);
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(email))
        {
            return Unauthorized();
        }

        return Ok(new UserDto(id, email));
    }
}